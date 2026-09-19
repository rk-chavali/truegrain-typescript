/**
 * The SDK is checked against the OpenAPI contract.
 *
 * This client is hand-written rather than generated, because the value is in
 * the parts no generator emits: `Refused.shouldModify`, and `run()` submitting
 * and polling a job so no caller writes that loop. The cost of hand-writing is
 * that it can silently fall behind the engine. These tests are what pay it.
 *
 * The spec is vendored at `spec/openapi.yaml` and pinned to an engine commit in
 * `spec/PINNED_AT`. Vendoring keeps this repository buildable offline and makes
 * a contract change a reviewable diff rather than a build that breaks one
 * morning because something moved in another repository. A scheduled job
 * compares the pin against the engine and opens a pull request when they
 * diverge.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Client, OPERATIONS } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(here, "..", "spec", "openapi.yaml");

interface SpecDoc {
  paths: Record<string, Record<string, { operationId?: string }>>;
}

function specOperations(): Map<string, string> {
  // Never skipped. The vendored spec is committed, so its absence is a broken
  // repository rather than an environment without the engine checked out, and
  // a skipped contract test is a contract test nobody notices is gone.
  expect(existsSync(SPEC), `the vendored spec is missing from ${SPEC}`).toBe(true);
  const doc = parse(readFileSync(SPEC, "utf8")) as SpecDoc;

  const found = new Map<string, string>();
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (operation.operationId) {
        found.set(operation.operationId, `${method.toUpperCase()} ${path}`);
      }
    }
  }
  return found;
}

describe("the client covers the contract", () => {
  it("has a method for every operation the engine exposes", () => {
    const missing: Record<string, string> = {};
    for (const [operationId, route] of specOperations()) {
      if (!(operationId in OPERATIONS)) missing[operationId] = route;
    }
    expect(
      missing,
      `the engine exposes operations this client cannot call: ${JSON.stringify(missing)}. ` +
        "Add a method and register it in OPERATIONS.",
    ).toEqual({});
  });

  it("claims no operation the spec does not define", () => {
    const known = specOperations();
    const stale = Object.entries(OPERATIONS).filter(([id]) => !known.has(id));
    expect(
      Object.fromEntries(stale),
      "OPERATIONS names operations the spec does not define. " +
        "Either the spec lost an endpoint or the mapping is wrong.",
    ).toEqual({});
  });

  it("maps every operation to a method that actually exists", () => {
    for (const [operationId, methodName] of Object.entries(OPERATIONS)) {
      const method = (Client.prototype as unknown as Record<string, unknown>)[methodName];
      expect(
        typeof method,
        `OPERATIONS maps ${operationId} to Client.${methodName}, which does not exist`,
      ).toBe("function");
    }
  });

  it("exposes no method that sends SQL", () => {
    // The raw-SQL guarantee applied to the client surface. There is no endpoint
    // that accepts SQL, so there must be no method that offers to send it.
    const names = Object.getOwnPropertyNames(Client.prototype);
    for (const name of names) {
      expect(name.toLowerCase()).not.toContain("sql");
      expect(name.toLowerCase()).not.toContain("raw");
    }
  });
});
