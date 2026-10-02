/**
 * A product's data never lands in this repository. Glossaries, catalogs and council output belong in
 * the product's repo or the team's own store. The only glossaries here are the synthetic examples
 * under fixtures/ and test/. .gitignore catches accidental adds; this catches forced ones and
 * pull requests.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files the council writes for a team: run, tidy, harvest, apply and sweep output. */
const OUTPUT_FILES = new Set([
  "glossary-proposals.json",
  "glossary.next.json",
  "affected-keys.json",
  "inventory.json",
  "inventory.csv",
  "inventory.sql",
  "candidates.json",
  "backtranslations.json",
  "scores.json",
  "escalate.json",
  "accepted.json",
  "tidy.json",
  "tidy.csv",
]);

const exampleData = (f) => f.startsWith("fixtures/") || f.startsWith("test/");

it("no product glossary or council output is committed outside fixtures/ and test/", (t) => {
  const git = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  if (git.status !== 0) return t.skip("not a git checkout");
  const offenders = [];
  for (const f of git.stdout.split("\0").filter(Boolean)) {
    if (exampleData(f)) continue;
    if (OUTPUT_FILES.has(basename(f))) {
      offenders.push(`${f} (council output)`);
      continue;
    }
    if (!f.endsWith(".json") || f.startsWith("schemas/")) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(ROOT, f), "utf8"));
    } catch {
      continue;
    }
    if (doc?.schemaVersion === "0" && Array.isArray(doc.entries)) offenders.push(`${f} (a glossary)`);
  }
  assert.deepEqual(
    offenders,
    [],
    "A product's glossary and council output belong in the product's repo or the team's own store, not in " +
      "localization-council. Example glossaries go under fixtures/.",
  );
});
