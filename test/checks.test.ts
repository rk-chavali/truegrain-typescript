import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { Client, Refused } from "../src/index.js";

/**
 * What the engine says about itself, and where the served model came from.
 *
 * Two kinds of failure to guard. A field can be dropped on the way in, which
 * the parsing tests cover. And a 404 meaning "nobody configured this" can
 * arrive as something a caller cannot branch on, which is the difference
 * between an engine whose tests all pass and an engine that was never given
 * any.
 *
 * The origin tests exist because the Go client shipped without that field
 * while its own reload documentation told callers to read it. The operation
 * coverage test could not catch that: it checks every operationId has a
 * method, not that every documented field has somewhere to land. So they read
 * the vendored spec rather than trusting this file.
 */

function clientWith(
  handler: (path: string, body: unknown) => { status?: number; body: unknown },
) {
  const seen: { path: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const parsed = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ path, method: init?.method ?? "GET", body: parsed });
    const { status = 200, body } = handler(path, parsed);
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

const DOCTOR = {
  ok: false,
  tables_checked: 12,
  findings: [
    {
      severity: "error",
      dataset: "orders",
      field: "region",
      source: "analytics.fct_orders",
      message: "the model names a column the warehouse does not have",
      hint: "drop the field, or point it at the column that replaced it",
    },
    { severity: "warning", dataset: "customers", message: "the warehouse type widened" },
  ],
};

describe("doctor", () => {
  it("keeps the verdict separate from the findings", async () => {
    const { client } = clientWith(() => ({ body: DOCTOR }));

    const report = await client.doctor();

    expect(report.ok).toBe(false);
    expect(report.tablesChecked).toBe(12);
    // Severity is the whole point: a warning and an error read the same to
    // anybody who only counts findings.
    expect(report.findings.map((f) => f.severity)).toEqual(["error", "warning"]);
    expect(report.findings[0]?.hint).not.toBe("");
    expect(report.findings[0]?.source).toBe("analytics.fct_orders");
  });

  it("reports why nothing was checked", async () => {
    /*
      An executor that cannot introspect produces no findings, which is exactly
      what a healthy model produces. Without `skipped` the two are identical,
      and the wrong one is reassuring.
    */
    const { client } = clientWith(() => ({
      body: {
        ok: true,
        tables_checked: 0,
        findings: [],
        skipped: "this executor cannot describe the warehouse",
      },
    }));

    expect((await client.doctor()).skipped).not.toBe("");
  });
});

describe("an engine that was never configured for something", () => {
  const cases = [
    ["runTests", (c: Client) => c.runTests()],
    ["diff", (c: Client) => c.diff()],
    ["doctorHistory", (c: Client) => c.doctorHistory()],
    ["reload", (c: Client) => c.reload()],
  ] as const;

  for (const [name, call] of cases) {
    it(`reports ${name} as a refusal, not a transport failure`, async () => {
      const { client } = clientWith(() => ({
        status: 404,
        body: { code: "not_served", reason: "nobody configured this", retry: "never" },
      }));

      await expect(call(client)).rejects.toBeInstanceOf(Refused);
      await call(client).catch((error: unknown) => {
        expect((error as Refused).isFinal).toBe(true);
      });
    });
  }
});

describe("runTests", () => {
  it("reports what it did not run", async () => {
    /*
      The failure this guards is a green suite that never executed half its
      cases, which is worse than a red one.
    */
    const { client, seen } = clientWith(() => ({
      body: {
        ok: true,
        passed: 3,
        failed: 0,
        skipped: 0,
        withheld: 4,
        results: [
          { name: "a fan-out is refused", passed: true, duration_ms: 12 },
          {
            name: "revenue by region",
            passed: false,
            skipped: true,
            reason: "this credential may not run a query",
          },
        ],
      },
    }));

    const report = await client.runTests();

    expect(report.ok).toBe(true);
    expect(report.withheld, "withheld was dropped, so ok reads as a full pass").toBe(4);
    expect(report.results[0]?.durationMs).toBe(12);
    expect(report.results[1]?.reason).not.toBe("");
    expect(seen[0]?.method).toBe("POST");
  });
});

describe("policy", () => {
  it("carries the notes that say what is not enforced", async () => {
    const { client } = clientWith(() => ({
      body: {
        governance: {
          resolver: "allow-all",
          column_level: false,
          note: "every caller reads every column",
        },
        enforcement_notes: ["no column-level access control is configured"],
      },
    }));

    const policy = await client.policy();

    // An engine running allow-all has to say so, or a reader assumes a gate
    // exists because the product has one.
    expect(policy.governance.columnLevel).toBe(false);
    expect(policy.enforcementNotes.length).toBeGreaterThan(0);
  });

  it("sends the metric to explain, and refuses an empty one", async () => {
    const { client, seen } = clientWith(() => ({
      body: {
        metric: "retail.order_revenue",
        identity: "analyst@acme.com",
        readable: ["customers.region", "orders.placed_at"],
      },
    }));

    const explained = await client.explainPolicy("retail.order_revenue");
    expect(explained.identity).toBe("analyst@acme.com");
    expect(explained.readable).toHaveLength(2);
    expect(seen[0]?.body).toEqual({ metric: "retail.order_revenue" });

    await expect(client.explainPolicy("")).rejects.toBeInstanceOf(TypeError);
    expect(seen, "an empty metric reached the engine").toHaveLength(1);
  });
});

describe("diff", () => {
  it("carries the before and the after", async () => {
    /*
      Added and removed name things; altered is the one that says a number
      moved, and it is useless without both sides.
    */
    const { client } = clientWith(() => ({
      body: {
        changed: true,
        from: "sha256:aaa",
        to: "sha256:bbb",
        added: ["retail.refund_total"],
        removed: [],
        altered: {
          "order_revenue by region": {
            before: "SELECT sum(amount) ...",
            after: "SELECT sum(amount_net) ...",
          },
        },
      },
    }));

    const diff = await client.diff();

    expect(diff.changed).toBe(true);
    expect(diff.from).not.toBe(diff.to);
    const change = diff.altered["order_revenue by region"];
    expect(change?.before).not.toBe("");
    expect(change?.after).not.toBe("");
    expect(change?.before, "a diff with one side is not a diff").not.toBe(change?.after);
  });
});

describe("reload", () => {
  for (const want of ["reading", "already running"] as const) {
    it(`says ${want} happened`, async () => {
      // A pipeline that treats "already running" as a failure retries a sync
      // that is already under way.
      const { client, seen } = clientWith(() => ({ status: 202, body: { status: want } }));

      expect(await client.reload()).toBe(want);
      // It means "look now", not "install this". A body would be a second way
      // into production.
      expect(seen[0]?.body).toEqual({});
    });
  }

  it("reports a failed load as a refusal to modify", async () => {
    /*
      The engine keeps serving the previous model and answers 502. A pipeline
      must be able to tell that from the network being down, because only one
      of them means the deploy did not land.
    */
    const { client } = clientWith(() => ({
      status: 502,
      body: {
        code: "model_did_not_load",
        reason: "the previously loaded model is still being served",
        retry: "modify",
      },
    }));

    await client.reload().catch((error: unknown) => {
      expect(error).toBeInstanceOf(Refused);
      expect((error as Refused).shouldModify).toBe(true);
    });
    expect.assertions(2);
  });
});

// ---------- where the served model came from ----------

const here = dirname(fileURLToPath(import.meta.url));
const spec = parseYaml(
  readFileSync(resolve(here, "..", "spec", "openapi.yaml"), "utf8"),
) as Record<string, any>;

function specOriginProperties(): string[] {
  const health = spec.components?.schemas?.Health?.properties;
  expect(
    health?.origin,
    "the spec no longer describes health.origin; if the engine dropped it, drop " +
      "Health.origin too rather than leaving a field nothing fills",
  ).toBeDefined();
  return Object.keys(health.origin.properties).sort();
}

describe("origin", () => {
  it("is described by the spec, and the scan finds it", () => {
    // Guards the scan. One that silently matched nothing would make the test
    // below pass vacuously, which is worse than not having it.
    expect(specOriginProperties().length).toBeGreaterThanOrEqual(3);
  });

  it("carries the commit a deploy is confirmed by", async () => {
    /*
      Named for the thing a pipeline does. Reload deliberately names no commit,
      so the only way to know a deploy landed is to read it here.
    */
    const { client } = clientWith(() => ({
      body: {
        workspace: "retail",
        workspace_digest: "sha256:abc",
        origin: {
          repository: "https://github.com/acme/models.git",
          ref: "main",
          commit: "23523843c4f5b92df4f8628a96a79bb5cbbfa9ee",
          subdirectory: "models",
        },
      },
    }));

    const health = await client.health();

    expect(health.origin, "an engine following a repository reported no origin").toBeDefined();
    expect(health.origin?.commit).toBe("23523843c4f5b92df4f8628a96a79bb5cbbfa9ee");
    expect(health.origin?.ref).toBe("main");
    expect(health.origin?.subdirectory).toBe("models");
    // The URL must arrive as given. A credential in it is refused at startup,
    // so anything that looked like redaction here would be hiding a bug.
    expect(health.origin?.repository).not.toContain("@");

    // Every property the spec documents has somewhere to land. This is the
    // test that was missing when the Go client shipped without the field.
    const carried = Object.keys(health.origin ?? {});
    for (const name of specOriginProperties()) {
      expect(carried, `the engine reports origin.${name} and Origin has no field for it`).toContain(
        name,
      );
    }
  });

  it("is absent when the engine read its model from a path", async () => {
    // So "not under version control" is an undefined check rather than a
    // record of empty strings that reads like a repository nobody named.
    const { client } = clientWith(() => ({
      body: { workspace: "retail", workspace_digest: "sha256:abc" },
    }));

    expect((await client.health()).origin).toBeUndefined();
  });
});
