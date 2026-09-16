/**
 * Asynchronous execution: submit, poll, page, cancel.
 *
 * These cover the client's side of the contract. The engine's side, including
 * who may read a finished job, is tested in the engine repository.
 */

import { describe, expect, it, vi } from "vitest";
import { Client, Refused, TruegrainError } from "../src/index.js";

const SQL = 'SELECT "region", SUM("order_total") AS "order_revenue" FROM orders GROUP BY 1';

const ACCEPTED = {
  job_id: "j-1",
  state: "running",
  compiled_sql: SQL,
  columns: ["region", "order_revenue"],
  model_version: "sha256:abc123",
  namespace: "sales",
  dialect: "duckdb",
};

function finished(rows: unknown[][], opts: { rowCount?: number; cursor?: string } = {}) {
  const body: Record<string, unknown> = {
    job_id: "j-1",
    state: "succeeded",
    columns: ["region", "order_revenue"],
    rows,
    row_count: opts.rowCount ?? rows.length,
    compiled_sql: SQL,
    model_version: "sha256:abc123",
    namespace: "sales",
    dialect: "duckdb",
  };
  if (opts.cursor) body.next_cursor = opts.cursor;
  return body;
}

/** A fetch driven by a handler, so a test can vary the answer per call. */
function clientWith(handler: (path: string, method: string) => { status?: number; body: unknown }) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const { status = 200, body } = handler(path, method);
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
    calls,
  };
}

describe("submit", () => {
  it("returns the SQL before the query has finished", async () => {
    const { client } = clientWith(() => ({ status: 202, body: ACCEPTED }));
    const job = await client.submit({ metrics: ["sales.order_revenue"] });

    expect(job.jobId).toBe("j-1");
    expect(job.state).toBe("running");
    // Compilation is synchronous, so an agent can show its work without waiting
    // for the warehouse.
    expect(job.compiledSql).toContain("SUM");
  });
});

describe("run", () => {
  it("polls until the job finishes, then returns a result", async () => {
    let polls = 0;
    const { client } = clientWith((_path, method) => {
      if (method === "POST") return { status: 202, body: ACCEPTED };
      polls += 1;
      if (polls < 3) return { body: { job_id: "j-1", state: "running" } };
      return { body: finished([["NE", 750.0], ["MW", 135.5]]) };
    });

    const result = await client.run({ metrics: ["sales.order_revenue"] });

    expect(polls).toBe(3);
    expect(result.rowCount).toBe(2);
    expect(result.toObjects()[0]).toEqual({ region: "NE", order_revenue: 750.0 });
    // Provenance survives the asynchronous path exactly as it does the
    // synchronous one; that is the whole point of carrying it.
    expect(result.modelVersion).toBe("sha256:abc123");
  });

  it("collects every page", async () => {
    const pages: Record<string, unknown> = {
      "": finished([["a", 1], ["b", 2]], { rowCount: 5, cursor: "p2" }),
      p2: finished([["c", 3], ["d", 4]], { rowCount: 5, cursor: "p3" }),
      p3: finished([["e", 5]], { rowCount: 5 }),
    };
    const { client } = clientWith((path, method) => {
      if (method === "POST") return { status: 202, body: ACCEPTED };
      const cursor = new URL(path, "http://x").searchParams.get("cursor") ?? "";
      return { body: pages[cursor] };
    });

    const result = await client.run({ metrics: ["sales.order_revenue"] });

    expect(result.rowCount).toBe(5);
    expect(result.rows.map((r) => r[0])).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("stops paging once every row is collected", async () => {
    // A server that keeps handing out a cursor must not loop the client.
    // rowCount bounds the walk, so it does not depend on trusting the cursor.
    const { client } = clientWith((_path, method) =>
      method === "POST"
        ? { status: 202, body: ACCEPTED }
        : { body: finished([["a", 1]], { rowCount: 1, cursor: "never-ends" }) },
    );
    const result = await client.run({ metrics: ["sales.order_revenue"] });
    expect(result.rowCount).toBe(1);
  });

  it("throws at submit for a denial rather than after a wait", async () => {
    const { client } = clientWith(() => ({
      status: 403,
      body: { code: "access_denied", reason: "not readable", retry: "never" },
    }));

    try {
      await client.run({ metrics: ["sales.order_revenue"] });
      expect.unreachable("a denied request must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Refused);
      expect((error as Refused).isFinal).toBe(true);
    }
  });

  it("throws a failed job with its retry class", async () => {
    // A failed job polls as 200: the poll succeeded, the query did not.
    const { client } = clientWith((_path, method) =>
      method === "POST"
        ? { status: 202, body: ACCEPTED }
        : {
            body: {
              job_id: "j-1",
              state: "failed",
              code: "execution_failed",
              reason: "warehouse unavailable",
              retry: "later",
            },
          },
    );

    try {
      await client.run({ metrics: ["sales.order_revenue"] });
      expect.unreachable("a failed job must throw");
    } catch (error) {
      expect((error as Refused).shouldWait).toBe(true);
    }
  });

  it("does not report a cancelled job as a result", async () => {
    const { client } = clientWith((_path, method) =>
      method === "POST"
        ? { status: 202, body: ACCEPTED }
        : { body: { job_id: "j-1", state: "cancelled" } },
    );
    await expect(client.run({ metrics: ["m"] })).rejects.toThrow(/cancelled/);
  });

  it("cancels the job when the wait expires", async () => {
    // Giving up must stop the warehouse work, not just stop looking. Leaving it
    // running would keep spending on an answer nobody will read.
    const { client, calls } = clientWith((_p, method) => {
      if (method === "POST") return { status: 202, body: ACCEPTED };
      if (method === "DELETE") return { body: { job_id: "j-1", state: "cancelled" } };
      return { body: { job_id: "j-1", state: "running" } };
    });

    await expect(
      client.run({ metrics: ["sales.order_revenue"], maxWaitMs: 300 }),
    ).rejects.toThrowError(TruegrainError);

    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(true);
  });
});

describe("job paging arguments", () => {
  it("passes the cursor and page size to the server", async () => {
    const { client, calls } = clientWith(() => ({ body: finished([["a", 1]]) }));
    await client.job("j-1", { cursor: "p2", pageSize: 250 });
    expect(calls[0]).toContain("cursor=p2");
    expect(calls[0]).toContain("page_size=250");
  });

  it("requires a job id", async () => {
    const { client } = clientWith(() => ({ body: {} }));
    await expect(client.job("")).rejects.toThrow(TypeError);
    await expect(client.cancelJob("")).rejects.toThrow(TypeError);
  });
});

describe("cancel", () => {
  it("sends DELETE", async () => {
    const { client, calls } = clientWith(() => ({ body: { job_id: "j-1", state: "cancelled" } }));
    const job = await client.cancelJob("j-1");
    expect(job.state).toBe("cancelled");
    expect(calls[0]).toBe("DELETE /v1/jobs/j-1");
  });
});
