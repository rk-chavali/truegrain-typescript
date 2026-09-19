import { describe, expect, it, vi } from "vitest";
import { Client, TruegrainError } from "../src/index.js";

/**
 * Reading the decisions an engine made.
 *
 * Two things about this call are unlike every other one. It can 404 because
 * nobody configured it rather than because anything is wrong, and it can 403
 * because this caller is not a named reader. Both are about the deployment
 * rather than the request, and a consumer that treats them as "the engine is
 * broken" will tell an operator the wrong thing.
 */

function clientWith(handler: (url: string) => { status?: number; body: unknown }) {
  const seen: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    seen.push(path);
    const { status = 200, body } = handler(path);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return {
    client: new Client("http://engine.test", {
      token: "t",
      fetch: fetchImpl as unknown as typeof fetch,
    }),
    seen,
  };
}

const PAGE = {
  count: 2,
  note: "the most recent decisions held in memory",
  events: [
    {
      time: "2026-09-17T21:00:00Z",
      identity: "analyst@acme.com",
      decision: "refused",
      refusal_code: "fan_out_would_inflate",
      retry: "modify",
      reason: 'metric "order_revenue" aggregates SUM(...) over orders',
      hint: "Metrics defined at the order_lines grain answer this correctly",
      metrics: ["sales.order_revenue"],
      dimensions: ["sales.order_lines.item_id"],
      dialect: "bigquery",
      duration_ms: 3,
    },
    {
      time: "2026-09-17T20:59:00Z",
      identity: "ops@acme.com",
      decision: "allowed",
      row_count: 2,
      bytes_billed: 41943040,
      duration_ms: 1201,
      sql_hash: "sha256:deadbeef",
    },
  ],
};

describe("audit", () => {
  it("parses a refusal into something a screen can render", async () => {
    const { client } = clientWith(() => ({ body: PAGE }));
    const page = await client.audit();

    expect(page.count).toBe(2);
    const refusal = page.events[0]!;
    expect(refusal.decision).toBe("refused");
    expect(refusal.code).toBe("fan_out_would_inflate");
    expect(refusal.retry).toBe("modify");
    expect(refusal.hint).toContain("order_lines");
    expect(refusal.metrics).toEqual(["sales.order_revenue"]);
  });

  it("reads what a query cost, and does not invent a zero", async () => {
    const { client } = clientWith(() => ({ body: PAGE }));
    const page = await client.audit();

    expect(page.events[1]!.bytesBilled).toBe(41943040);
    // The refusal never reached a warehouse, so nothing was billed. Zero here
    // means not reported rather than free, and a spend screen has to say so.
    expect(page.events[0]!.bytesBilled).toBe(0);
  });

  it("names an anonymous caller rather than leaving a blank", async () => {
    const { client } = clientWith(() => ({
      body: { count: 1, events: [{ time: "t", decision: "allowed" }] },
    }));
    const page = await client.audit();
    expect(page.events[0]!.identity).toBe("anonymous");
  });

  it("sends the filter and the limit as query parameters", async () => {
    const { client, seen } = clientWith(() => ({ body: PAGE }));
    await client.audit({ limit: 25, decision: "refused" });

    expect(seen[0]).toContain("/v1/audit");
    expect(seen[0]).toContain("limit=25");
    expect(seen[0]).toContain("decision=refused");
  });

  it("asks for nothing it was not given", async () => {
    const { client, seen } = clientWith(() => ({ body: PAGE }));
    await client.audit();
    expect(seen[0]).toBe("/v1/audit");
  });

  // An engine that serves no audit log is not a broken engine, and a console
  // has to tell those apart to say anything useful to an operator.
  it("surfaces 404 as an engine that does not serve it", async () => {
    const { client } = clientWith(() => ({
      status: 404,
      body: { code: "audit_not_served", reason: "this engine does not serve recorded decisions", retry: "never" },
    }));
    await expect(client.audit()).rejects.toThrow(TruegrainError);
    await expect(client.audit()).rejects.toMatchObject({ code: "audit_not_served" });
  });

  it("surfaces 403 as this caller not being a reader", async () => {
    const { client } = clientWith(() => ({
      status: 403,
      body: { code: "not_an_audit_reader", reason: "this identity may not read recorded decisions", retry: "never" },
    }));
    await expect(client.audit()).rejects.toMatchObject({ code: "not_an_audit_reader" });
  });

  it("tolerates a page with no events", async () => {
    const { client } = clientWith(() => ({ body: { count: 0, events: [] } }));
    const page = await client.audit();
    expect(page.events).toEqual([]);
    expect(page.count).toBe(0);
  });

  // A field the engine has not sent yet must not become undefined in a screen.
  it("fills absent fields rather than leaving holes", async () => {
    const { client } = clientWith(() => ({
      body: { count: 1, events: [{ time: "t", identity: "a@b.c", decision: "denied" }] },
    }));
    const e = (await client.audit()).events[0]!;
    expect(e.code).toBe("");
    expect(e.retry).toBe("");
    expect(e.metrics).toEqual([]);
    expect(e.deniedFields).toEqual([]);
    expect(e.rowCount).toBe(0);
  });
});
