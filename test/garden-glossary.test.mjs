/**
 * Cross-app glossary growth: other apps' approved terms pre-fill proposals (`--reference`), and
 * `council garden --mode glossary` sweeps a whole garden into per-catalog proposals plus a term
 * inventory a team can keep in its own store (JSON, CSV for Notion, SQL for Postgres/Neon/SQLite).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";
import { validate } from "../src/json-schema.mjs";
import { inventoryCsv, inventorySql, INVENTORY_COLUMNS } from "../src/term-inventory.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const F = join(ROOT, "fixtures", "garden-glossary");
const A = join(F, "checkouts", "app-a", "locales");
const B = join(F, "checkouts", "app-b", "locales");
const tmp = () => mkdtempSync(join(tmpdir(), "lc-garden-gloss-"));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

async function council(args) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

function summary(r) {
  const s = JSON.parse(r.stdout);
  const v = validate(s, "summary.v1.json");
  assert.ok(v.ok, v.errors.join("; "));
  return s;
}

const SWEEP = ["garden", "--mode", "glossary", "--manifest", join(F, "garden.json"), "--root", join(F, "checkouts"), "--profile=mock"];
const HARVEST_B = [
  "glossary",
  "harvest",
  "--catalog",
  join(B, "en.json"),
  "--locale-file",
  join(B, "de.json"),
  "--locale",
  "de",
  "--glossary",
  join(B, "glossary.de.json"),
  "--profile=mock",
];

describe("glossary harvest --reference", () => {
  it("another app's approved terms pre-fill proposals and are proposed when this app's English uses them", async () => {
    const out = tmp();
    const s = summary(await council([...HARVEST_B, "--reference", `app-a=${join(A, "glossary.de.json")}`, "--out", out, "--json"]));
    assert.deepEqual(
      s.proposals.map((p) => [p.source, p.practitionerTerm, p.kind, p.from]),
      [
        ["keyframe", "Keyframe", "harvest", "app-a"],
        ["render queue", "Renderwarteschlange", "harvest", null],
        ["mask path", "Maskenpfad", "carry_over", "app-a"],
        ["onion skin", "Onion Skin", "carry_over", "app-a"],
      ],
    );
    const byId = Object.fromEntries(readJson(s.artifacts.proposals).proposals.map((p) => [p.id, p]));
    // The term and its rejected renderings carry over; the meaning is this app's to write.
    assert.deepEqual(byId.keyframe.reject.map((r) => r.term), ["Schlüsselbild"]);
    assert.match(byId.keyframe.reject[0].why, /\(rejected in app-a\)$/);
    assert.equal(byId.keyframe.crossApp, "differs");
    assert.equal(byId.keyframe.reference[0].productMeaning, "A stored property value at a point on the timeline.");
    assert.equal(byId["onion skin"].productMeaning, "");
    assert.deepEqual(byId["onion skin"].keys, []);
    assert.deepEqual(byId["onion skin"].affectedKeys, ["editor.onion.toggle"]);
    assert.equal(byId["onion skin"].crossApp, "not_shipped");
    assert.equal(byId["mask path"].crossApp, "agrees");
    // Terms both apps have stay out of the proposals, even when they're approved differently.
    assert.ok(!byId.layer && !byId.composition);
    assert.match(readFileSync(s.artifacts.report, "utf8"), /In `app-a`: \*\*Keyframe\*\*/);
  });

  it("an approved carry-over records where it came from", async () => {
    const out = tmp();
    const s = summary(await council([...HARVEST_B, "--reference", `app-a=${join(A, "glossary.de.json")}`, "--out", out, "--json"]));
    const doc = readJson(s.artifacts.proposals);
    for (const p of doc.proposals) if (p.id === "onion skin") Object.assign(p, { decision: "approve", productMeaning: "Ghosted neighbors in the editor timeline." });
    writeFileSync(s.artifacts.proposals, JSON.stringify(doc));
    const a = summary(await council(["glossary", "apply", "--proposals", s.artifacts.proposals, "--glossary", join(B, "glossary.de.json"), "--json"]));
    const entry = readJson(a.artifacts.glossary).entries.find((e) => e.source === "onion skin");
    assert.deepEqual(entry.origin, { via: "reference", from: "app-a", keys: [] });
    assert.equal(entry.productMeaning, "Ghosted neighbors in the editor timeline.");
    assert.deepEqual(entry.rejected.map((r) => r.term), ["Zwiebelschale"]);
  });

  it("refuses a reference glossary for another locale", async () => {
    const out = tmp();
    const ja = join(out, "glossary.ja.json");
    writeFileSync(ja, JSON.stringify({ ...readJson(join(A, "glossary.de.json")), locale: "ja", entries: [] }));
    assert.equal((await council([...HARVEST_B, "--reference", ja, "--out", out, "--json"])).code, 2);
  });
});

describe("council garden --mode glossary", () => {
  it("sweeps every active catalog, cross-referencing the other apps' glossaries; exit 10", async () => {
    const out = tmp();
    const r = await council([...SWEEP, "--out", out, "--json"]);
    assert.equal(r.code, 10);
    const s = summary(r);
    assert.equal(s.command, "garden");
    assert.equal(s.mode, "glossary");
    assert.equal(s.status, "proposals");
    assert.deepEqual(
      s.results.map((x) => [x.repo, x.locale, x.status, x.proposals ?? null, x.carryOver ?? null]),
      [
        ["example/app-a", "de", "PROPOSALS", 2, 1],
        ["example/app-b", "de", "PROPOSALS", 4, 2],
        ["example/app-b", "ja", "deferred_locale", null, null],
      ],
    );
    assert.equal(s.counts.conflicts, 1);
    for (const f of ["inventory", "csv", "sql", "report"]) assert.ok(existsSync(s.artifacts[f]), f);
    assert.ok(existsSync(join(out, "example", "app-b", "editor", "de", "glossary-proposals.json")));
    const inv = readJson(s.artifacts.inventory);
    assert.equal(inv.schema, "council.term-inventory.v1");
    const row = (term, repo) => inv.rows.find((x) => x.term === term && x.repo === repo);
    assert.deepEqual(Object.keys(row("layer", "example/app-a")), INVENTORY_COLUMNS);
    assert.equal(row("layer", "example/app-a").cross_app, "differs");
    assert.equal(row("layer", "example/app-b").other_apps, "example/app-a: Ebene");
    assert.equal(row("composition", "example/app-a").status, "carry_over");
    assert.equal(row("keyframe", "example/app-b").cross_app, "differs");
    assert.equal(row("playhead", "example/app-a").cross_app, "only_here");
    assert.equal(inv.conflicts[0].term, "layer");
    // No glossary is ever edited by a sweep.
    assert.equal(readJson(join(B, "glossary.de.json")).entries.length, 2);
  });

  it("a catalog with nothing shipped yet still gets the other apps' terms", async () => {
    const root = tmp();
    mkdirSync(join(root, "app-c", "locales"), { recursive: true });
    writeFileSync(join(root, "app-c", "locales", "en.json"), JSON.stringify({ "c.kf": "Add keyframe", "c.play": "Play" }));
    const manifest = join(root, "garden.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        repos: [
          { repo: "example/app-a", catalogs: [{ id: "ui", source: join(A, "en.json"), target: join(A, "de.json"), locale: "de", glossary: join(A, "glossary.de.json") }] },
          { repo: "example/app-c", catalogs: [{ id: "ui", source: "locales/en.json", target: "locales/de.json", locale: "de", glossary: "locales/glossary.de.json" }] },
        ],
      }),
    );
    const s = summary(await council(["garden", "--mode", "glossary", "--manifest", manifest, "--root", root, "--profile=mock", "--out", join(root, "out"), "--json"]));
    const c = s.results.find((x) => x.repo === "example/app-c");
    assert.equal(c.status, "PROPOSALS");
    assert.equal(c.targetMissing, true);
    assert.equal(c.pairs, 0);
    const doc = readJson(c.proposalsFile);
    assert.deepEqual(doc.proposals.map((p) => [p.id, p.kind, p.practitionerTerm]), [["keyframe", "carry_over", "Keyframe"]]);
    // Apply starts the declared glossary path.
    assert.match(readFileSync(c.report, "utf8"), new RegExp(`--glossary ${join(root, "app-c", "locales", "glossary.de.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("keeps a person's decisions across sweeps into the same --out", async () => {
    const out = tmp();
    const first = summary(await council([...SWEEP, "--out", out, "--json"]));
    const file = first.results.find((x) => x.repo === "example/app-b" && x.locale === "de").proposalsFile;
    const doc = readJson(file);
    doc.proposals.find((p) => p.id === "render queue").decision = "decline";
    writeFileSync(file, JSON.stringify(doc));
    const again = summary(await council([...SWEEP, "--out", out, "--json"]));
    assert.equal(readJson(file).proposals.find((p) => p.id === "render queue").decision, "decline");
    const inv = readJson(again.artifacts.inventory);
    assert.equal(inv.rows.find((x) => x.term === "render queue").decision, "decline");
  });

  it("reports a missing source as an error and still sweeps the rest", async () => {
    const root = tmp();
    const manifest = join(root, "garden.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        repos: [
          { repo: "example/app-a", catalogs: [{ id: "ui", source: join(A, "en.json"), target: join(A, "de.json"), locale: "de", glossary: join(A, "glossary.de.json") }] },
          { repo: "example/gone", catalogs: [{ id: "ui", source: "locales/en.json", target: "locales/de.json", locale: "de" }] },
        ],
      }),
    );
    const r = await council(["garden", "--mode", "glossary", "--manifest", manifest, "--root", root, "--profile=mock", "--out", join(root, "out"), "--json"]);
    assert.equal(r.code, 1);
    const s = summary(r);
    assert.equal(s.status, "errors");
    assert.equal(s.results.find((x) => x.repo === "example/app-a").status, "PROPOSALS");
    assert.match(s.errors[0].message, /example\/gone/);
  });

  it("flags for one walk are refused on the other", async () => {
    const base = ["garden", "--manifest", join(F, "garden.json"), "--root", join(F, "checkouts"), "--json"];
    assert.equal((await council([...base, "--profile=mock"])).code, 2, "dry-diff calls no provider");
    assert.equal((await council([...base, "--mode", "glossary", "--dry-diff"])).code, 2);
    assert.equal((await council([...base, "--mode", "nightly"])).code, 2);
    assert.equal((await council([...base])).code, 0, "dry-diff still works");
  });
});

describe("term inventory exports", () => {
  const row = (over) => Object.fromEntries(INVENTORY_COLUMNS.map((c) => [c, over[c] ?? (c === "consistent" ? true : c.startsWith("keys") ? 0 : "x")]));

  it("CSV quotes what needs quoting and never starts a cell with a formula", () => {
    const csv = inventoryCsv([row({ term: "=HYPERLINK(1)", product_meaning: 'says "hi", twice\nok', other_apps: "+1" })]);
    const [header, body] = csv.split("\n");
    assert.equal(header, INVENTORY_COLUMNS.join(","));
    assert.ok(body.startsWith("'=HYPERLINK(1),"));
    assert.ok(csv.includes('"says ""hi"", twice\nok"'));
    assert.ok(csv.includes(",'+1,"));
  });

  it("SQL escapes quotes, drops NUL, and refuses an unsafe table name", () => {
    const sql = inventorySql([row({ term: "it's", product_meaning: "a\u0000b'); DROP TABLE x; --", swept_at: "t" })]);
    assert.ok(sql.includes("'it''s'"));
    assert.ok(sql.includes("'ab''); DROP TABLE x; --'"));
    assert.throws(() => inventorySql([], { table: "x; DROP" }), /Invalid table name/);
  });

  it("loads into SQLite twice and upserts instead of duplicating", async (t) => {
    let sqlite;
    try {
      sqlite = await import("node:sqlite");
    } catch {
      return t.skip("node:sqlite needs Node 22.5+");
    }
    const out = tmp();
    const s = summary(await council([...SWEEP, "--out", out, "--json"]));
    const db = new sqlite.DatabaseSync(":memory:");
    const sql = readFileSync(s.artifacts.sql, "utf8");
    db.exec(sql);
    db.exec(sql);
    assert.equal(db.prepare("SELECT count(*) AS n FROM council_terms").get().n, s.counts.terms);
    const conflict = db.prepare("SELECT count(*) AS n FROM council_terms WHERE term = 'layer' AND cross_app = 'differs'").get();
    assert.equal(conflict.n, 2);
  });
});
