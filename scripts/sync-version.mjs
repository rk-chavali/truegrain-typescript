/**
 * Copy the version from package.json into the VERSION export.
 *
 * Run by the `version` lifecycle script, which npm invokes after it bumps
 * package.json and before it makes the version commit, so the edit lands in
 * that same commit and the tag never points at a source tree that disagrees
 * with the package it produces.
 *
 * Writing the literal rather than importing package.json at runtime keeps the
 * published module free of a JSON import, which needs an import attribute and
 * is resolved differently by bundlers, Node and the browser.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const target = resolve(root, "src", "index.ts");
const source = readFileSync(target, "utf8");

const declaration = /export const VERSION = "[^"]*";/;
if (!declaration.test(source)) {
  // Failing loudly beats bumping a version that silently stops being synced.
  console.error(`no VERSION declaration found in ${target}`);
  process.exit(1);
}

const updated = source.replace(declaration, `export const VERSION = "${version}";`);
if (updated !== source) {
  writeFileSync(target, updated);
  console.log(`VERSION set to ${version}`);
}
