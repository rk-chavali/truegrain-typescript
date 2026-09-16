/**
 * Transport, parsing and error mapping.
 *
 * The client's job is those three things. Testing it against a real engine
 * would test the engine instead, and would make these tests need a warehouse.
 * A stub fetch records what it was sent, which is how the request-shaping tests
 * assert the client does not send fields the server would reject.
 */

import { describe, expect, it, vi } from "vitest";
import { Client, Refused, TransportError, Unauthorized, filters } from "../src/index.js";

interface Sent {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A fetch that answers with canned payloads and records every request. */
function stub(
  routes: Record<string, { status?: number; body: unknown } | ((sent: Sent) => { status?: number; body: unknown })>,
) {
  const sent: Sent[] = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const record: Sent = {
      url: path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    sent.push(record);

    const key = `${record.method} ${path.split("?")[0]}`;
    const route = routes[key];
    if (!route) {
      return new Response(JSON.stringify({ code: "not_found", reason: "no stub route", retry: "never" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const resolved = typeof route === "function" ? route(record) : route;
    return new Response(JSON.stringify(resolved.body), {
      status: resolved.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  return { fetchImpl, sent };
}

function clientWith(routes: Parameters<typeof stub>[0]) {
  const { fetchImpl, sent } = stub(routes);
  return {
    client: new Client("http://engine.test", { token: "test-token", fetch: fetchImpl as unknown as typeof fetch }),
    sent,
  };
}

const QUERY_RESPONSE = {
  columns: ["region", "order_revenue"],
  rows: [
    ["NE", 750.0],
    ["MW", 135.5],
  ],
  row_count: 2,
  compiled_sql: 'SELECT "region", SUM("order_total") AS "order_revenue" FROM orders',
  model_version: "sha256:abc123",
  dialect: "duckdb",
  namespace: "sales",
};

describe("query", () => {
  it("parses rows and the provenance that settles a disputed number", async () => {
    const { client } = clientWith({ "POST /v1/query": { body: QUERY_RESPONSE } });

    const result = await client.query({ metrics: ["sales.order_revenue"] });

    expect(result.columns).toEqual(["region", "order_revenue"]);
    expect(result.rowCount).toBe(2);
    // Provenance travels with every result. Losing it at the client boundary
    // would defeat the point of carrying it.
    expect(result.modelVersion).toBe("sha256:abc123");
    expect(result.compiledSql).toContain("SUM");
  });

  it("returns rows as objects keyed by column", async () => {
    const { client } = clientWith({ "POST /v1/query": { body: QUERY_RESPONSE } });
    const rows = (await client.query({ metrics: ["sales.order_revenue"] })).toObjects();
    expect(rows[0]).toEqual({ region: "NE", order_revenue: 750.0 });
  });

  it("omits absent fields rather than sending them empty", async () => {
    // The server rejects unknown and malformed fields, and an empty list is not
    // the same as absent.
    const { client, sent } = clientWith({ "POST /v1/query": { body: QUERY_RESPONSE } });
    await client.query({ metrics: ["sales.order_revenue"] });
    expect(sent[0]!.body).toEqual({ metrics: ["sales.order_revenue"] });
  });

  it("sends filters as structured objects, never as SQL text", async () => {
    const { client, sent } = clientWith({ "POST /v1/query": { body: QUERY_RESPONSE } });
    await client.query({
      metrics: ["sales.order_revenue"],
      filters: [filters.eq("sales.orders.status", "shipped")],
    });
    expect(sent[0]!.body).toMatchObject({
      filters: [{ dimension: "sales.orders.status", op: "eq", values: ["shipped"] }],
    });
  });

  it("refuses to send a request with no metrics", async () => {
    const { client } = clientWith({});
    await expect(client.query({ metrics: [] })).rejects.toThrow(TypeError);
  });
});

describe("refusals", () => {
  it("carries the code and retry class through as an error", async () => {
    const { client } = clientWith({
      "POST /v1/query": {
        status: 422,
        body: {
          code: "fan_out_would_inflate",
          reason: "the total would be inflated",
          hint: "use line_revenue instead",
          retry: "modify",
        },
      },
    });

    await expect(client.query({ metrics: ["sales.order_revenue"] })).rejects.toThrowError(Refused);

    try {
      await client.query({ metrics: ["sales.order_revenue"] });
    } catch (error) {
      const refusal = error as Refused;
      expect(refusal.code).toBe("fan_out_would_inflate");
      // The whole point: an agent branches on this rather than on the text.
      expect(refusal.shouldModify).toBe(true);
      expect(refusal.isFinal).toBe(false);
      expect(refusal.hint).toContain("line_revenue");
      expect(refusal.status).toBe(422);
    }
  });

  it("classifies a denial as final so an agent stops rather than looping", async () => {
    const { client } = clientWith({
      "POST /v1/query": {
        status: 403,
        body: { code: "access_denied", reason: "not readable", retry: "never" },
      },
    });
    try {
      await client.query({ metrics: ["sales.order_revenue"] });
      expect.unreachable("a denial must throw");
    } catch (error) {
      expect((error as Refused).isFinal).toBe(true);
      expect((error as Refused).shouldModify).toBe(false);
    }
  });

  it("maps 401 to Unauthorized rather than to a refusal", async () => {
    const { client } = clientWith({
      "GET /v1/metrics": { status: 401, body: { code: "unauthenticated", reason: "no" } },
    });
    await expect(client.metrics()).rejects.toThrowError(Unauthorized);
  });

  it("treats an unreachable engine as transport, never as a statement about the request", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new Client("http://engine.test", { fetch: failing as unknown as typeof fetch });
    await expect(client.health()).rejects.toThrowError(TransportError);
  });

  it("is catchable as the library's base error", async () => {
    const { client } = clientWith({
      "POST /v1/query": { status: 403, body: { code: "access_denied", reason: "x", retry: "never" } },
    });
    // instanceof has to work for a caller that wants one catch for everything.
    const { TruegrainError } = await import("../src/index.js");
    await expect(client.query({ metrics: ["m"] })).rejects.toThrowError(TruegrainError);
  });
});

describe("authentication", () => {
  it("sends the bearer token", async () => {
    const { client, sent } = clientWith({ "GET /v1/health": { body: { model: "retail" } } });
    await client.health();
    expect(sent[0]!.headers.Authorization).toBe("Bearer test-token");
  });

  it("omits the header entirely when there is no token", async () => {
    const { fetchImpl, sent } = stub({ "GET /v1/health": { body: { model: "retail" } } });
    const client = new Client("http://engine.test", { fetch: fetchImpl as unknown as typeof fetch });
    await client.health();
    expect(sent[0]!.headers.Authorization).toBeUndefined();
  });
});

describe("metadata", () => {
  it("parses the real health shape, where dialect is an object not a string", async () => {
    // Caught by running against a real engine: dialect reports what the
    // warehouse secures by itself, separately from what the engine enforces.
    const { client } = clientWith({
      "GET /v1/health": {
        body: {
          workspace: "marketing, sales",
          workspace_digest: "sha256:a3d1609ce68b",
          dialect: { dialect: "duckdb", column_level_security: false, row_level_security: false },
          governance: { resolver: "allow-all", column_level: false, note: "No access control." },
          executor: "duckdb-cli",
          metric_count: 10,
          enforcement_notes: ["No column-level access control is configured."],
        },
      },
    });

    const health = await client.health();

    expect(health.dialect.dialect).toBe("duckdb");
    expect(health.dialect.columnLevelSecurity).toBe(false);
    expect(health.governance.resolver).toBe("allow-all");
    expect(health.workspaceDigest).toBe("sha256:a3d1609ce68b");
    expect(health.metricCount).toBe(10);
    // The gaps are what a reader needs most.
    expect(health.enforcementNotes[0]).toContain("No column-level");
  });

  it("normalises dimensions whether they arrive as names or objects", async () => {
    // listMetrics returns bare names, describeMetric returns objects. A caller
    // should not have to know which call produced the metric.
    const { client } = clientWith({
      "GET /v1/metrics": {
        body: { metrics: [{ name: "order_revenue", dimensions: ["customers.region"] }] },
      },
      "GET /v1/metrics/order_revenue": {
        body: { name: "order_revenue", dimensions: [{ name: "customers.region", datatype: "String" }] },
      },
    });
    expect((await client.metrics())[0]!.dimensions).toEqual(["customers.region"]);
    expect((await client.metric("order_revenue")).dimensions).toEqual(["customers.region"]);
  });
});

describe("browser compatibility", () => {
  it("calls fetch bound to its global, not detached", async () => {
    // A browser's fetch throws "Illegal invocation" when called without its
    // window as the receiver. Under Node it does not, so this would otherwise
    // only ever fail for a user. Shipped broken in 0.1.0.
    let receiver: unknown = "never called";
    const globalLike = {
      fetch(this: unknown) {
        receiver = this;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    };

    const client = new Client("http://engine.test", {
      fetch: globalLike.fetch as unknown as typeof fetch,
    });
    await client.health();

    expect(receiver, "fetch must be invoked with a receiver, not detached").not.toBe(undefined);
  });
});
