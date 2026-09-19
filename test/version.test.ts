/**
 * The exported VERSION has to be the version that was published.
 *
 * It is a hand-written literal in a file `npm version` does not touch, so
 * nothing about bumping the package keeps it honest. 0.1.2 shipped reporting
 * itself as 0.1.1, which is the kind of wrong that survives a release because
 * nothing reads it until someone is trying to work out which client produced
 * a bug report, at which point it sends them to the wrong source.
 *
 * `npm version` now syncs it through the `version` lifecycle script. This test
 * is the check on that script rather than a substitute for it: if the sync
 * stops running, the release fails here instead of on the registry.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(here, "..", "package.json"), "utf8"),
) as { version: string };

describe("VERSION", () => {
  it("is the version in package.json", () => {
    expect(VERSION).toBe(manifest.version);
  });

  it("is a plain semantic version, because it goes into bug reports verbatim", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
