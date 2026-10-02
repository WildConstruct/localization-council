/**
 * Glossary growth: harvest proposes entries for recurring terms in shipped strings, a person
 * decides, apply folds the decisions into the glossary, and the council then enforces the new
 * entries (tidy reopens shipped strings that use a rejected rendering).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";
import { validate } from "../src/json-schema.mjs";
import { verifyTerms, groupTerms, applyProposals, mergeDecisions } from "../src/glossary-growth.mjs";
import { validateGlossary } from "../src/glossary.mjs";
import { startFakeOpenRouter } from "./helpers/fake-openrouter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIX = join(__dirname, "fixtures");
const G = join(ROOT, "fixtures", "glossary-growth");
const tmp = () => mkdtempSync(join(tmpdir(), "lc-gloss-"));
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

function harvestArgs({ locale = "de", glossary = join(G, "glossary.de.json"), profile = "mock" } = {}) {
  return [
    "glossary",
    "harvest",
    "--catalog",
    join(G, "en.json"),
    "--locale-file",
    join(G, "de.json"),
    "--locale",
    locale,
    "--glossary",
    glossary,
    `--profile=${profile}`,
  ];
}
const HARVEST = harvestArgs();

function decide(path, decisions) {
  const doc = readJson(path);
  for (const p of doc.proposals) Object.assign(p, decisions[p.id] ?? {});
  writeFileSync(path, JSON.stringify(doc, null, 2));
}

describe("verifyTerms / groupTerms", () => {
  it("drops answers the strings don't back up", () => {
    const rows = [
      {
        key: "a",
        source: "Add layer",
        candidate: "Ebene hinzufügen",
        terms: [
          { source: "layer", target: "Ebene", base: "Ebene", productMeaning: "" },
          { source: "keyframe", target: "Ebene", base: "Ebene", productMeaning: "" },
          { source: "layer", target: "Schicht", base: "Schicht", productMeaning: "" },
        ],
      },
    ];
    const { observations, unverified } = verifyTerms(rows);
    assert.equal(observations.length, 1);
    assert.deepEqual(unverified.map((u) => u.reason), ["term_not_in_source", "rendering_not_in_translation"]);
  });

  it("groups spellings and renderings, and sets each term's status against the glossary", () => {
    const obs = [
      { key: "a", source: "layer", target: "Ebene", base: "Ebene", productMeaning: "track" },
      { key: "b", source: "Layers", target: "Ebenen", base: "Ebene", productMeaning: "track" },
      { key: "c", source: "keyframe", target: "Keyframe", base: "Keyframe", productMeaning: "" },
      { key: "d", source: "keyframe", target: "Schlüsselbild", base: "Schlüsselbild", productMeaning: "" },
      { key: "e", source: "viewport", target: "Viewport", base: "Viewport", productMeaning: "" },
      { key: "f", source: "viewport", target: "Viewport", base: "Viewport", productMeaning: "" },
      { key: "g", source: "composition", target: "Komposition", base: "Komposition", productMeaning: "" },
      { key: "h", source: "mask path", target: "Maskenpfad", base: "Maskenpfad", productMeaning: "" },
    ];
    const glossary = readJson(join(G, "glossary.de.json"));
    const enMap = { a: "Add layer", b: "Rename layers", x: "Layer blending", y: "Player" };
    const terms = Object.fromEntries(groupTerms({ observations: obs, glossary, enMap }).map((t) => [t.id, t]));
    assert.equal(terms.layer.status, "proposed");
    assert.deepEqual(terms.layer.keys, ["a", "b"]);
    assert.deepEqual(terms.layer.renderings, [{ term: "Ebene", forms: ["Ebene", "Ebenen"], keys: ["a", "b"] }]);
    assert.deepEqual(terms.layer.affectedKeys, ["a", "b", "x"]);
    assert.equal(terms.layer.consistent, true);
    assert.equal(terms.keyframe.consistent, false);
    assert.equal(terms.viewport.status, "declined");
    assert.equal(terms.composition.status, "in_glossary");
    assert.equal(terms["mask path"].status, "below_min_keys");
    assert.equal(groupTerms({ observations: obs, glossary, enMap, minKeys: 1 }).find((t) => t.id === "mask path").status, "proposed");
  });
});

describe("council glossary harvest", () => {
  it("proposes recurring terms the glossary doesn't cover; disagreeing renderings first; exit 10", async () => {
    const out = tmp();
    const r = await council([...HARVEST, "--out", out, "--json"]);
    assert.equal(r.code, 10);
    const s = summary(r);
    assert.equal(s.command, "glossary");
    assert.equal(s.action, "harvest");
    assert.equal(s.status, "proposals");
    assert.equal(s.extractor, "mock");
    assert.deepEqual(
      s.proposals.map((p) => [p.source, p.practitionerTerm, p.keys, p.consistent]),
      [
        ["keyframe", "Keyframe", 3, false],
        ["layer", "Ebene", 3, true],
        ["render queue", "Renderwarteschlange", 2, true],
      ],
    );
    assert.equal(s.counts.skippedIdentical, 1); // "Pause" is identical to its source
    assert.equal(s.counts.inGlossary, 2);
    assert.equal(s.counts.declined, 1); // viewport
    for (const f of ["proposals", "report", "terms", "manifest"]) assert.ok(existsSync(s.artifacts[f]), f);
    const m = validate(readJson(s.artifacts.manifest), "glossary-manifest.v1.json");
    assert.ok(m.ok, m.errors.join("; "));
    const doc = readJson(s.artifacts.proposals);
    assert.equal(doc.schema, "council.glossary-proposals.v1");
    assert.equal(doc.proposals[0].decision, null);
    assert.deepEqual(doc.proposals[0].suggested, {
      source: "keyframe",
      practitionerTerm: "Keyframe",
      productMeaning: doc.proposals[0].productMeaning,
      reject: [],
    });
    assert.match(readFileSync(s.artifacts.report, "utf8"), /keyframe \(3 keys, renderings disagree\)/);
    // The glossary itself is never touched by harvest.
    assert.deepEqual(readJson(join(G, "glossary.de.json")).entries.length, 2);
  });

  it("a re-harvest keeps a person's decisions and edits, refreshes evidence, and costs nothing", async () => {
    const out = tmp();
    const first = summary(await council([...HARVEST, "--out", out, "--json"]));
    decide(first.artifacts.proposals, {
      keyframe: { decision: "approve", reject: ["Schlüsselbild"] },
      layer: { productMeaning: "One track in a composition." },
    });
    const again = summary(await council([...HARVEST, "--out", out, "--json"]));
    assert.equal(again.counts.keptDecisions, 2);
    assert.equal(again.counts.cacheHits, again.counts.pairs);
    const doc = readJson(again.artifacts.proposals);
    const byId = Object.fromEntries(doc.proposals.map((p) => [p.id, p]));
    assert.equal(byId.keyframe.decision, "approve");
    assert.deepEqual(byId.keyframe.reject, ["Schlüsselbild"]);
    assert.equal(byId.layer.productMeaning, "One track in a composition.");
    assert.equal(byId.layer.decision, null);
    assert.equal(byId["render queue"].productMeaning, byId["render queue"].suggested.productMeaning);
  });

  it("--accepted adds a run's not-yet-merged strings; nothing to propose is clean and quiet", async () => {
    const out = tmp();
    const accepted = join(out, "accepted.json");
    writeFileSync(
      accepted,
      JSON.stringify({ locale: "de", note: "x", strings: { "ui.mask.path": "Maskenpfad", "ui.timeline.pause": "Anhalten" }, via: {} }),
    );
    const s = summary(await council([...HARVEST, "--accepted", accepted, "--out", out, "--min-keys", "1", "--json"]));
    assert.equal(s.counts.fromAccepted, 2);
    assert.equal(s.counts.skippedIdentical, 0); // the accepted "Anhalten" replaced the identical "Pause"
    assert.ok(s.proposals.some((p) => p.source === "mask path"));

    const clean = await council([...HARVEST, "--min-keys", "99", "--out", tmp()]);
    assert.equal(clean.code, 0);
    assert.equal(clean.stdout, "");
  });

  it("never overwrites a proposals file it can't read", async () => {
    const out = tmp();
    const h = summary(await council([...HARVEST, "--out", out, "--json"]));
    const broken = readFileSync(h.artifacts.proposals, "utf8").replace('"decision": null', '"decision": "approve",,');
    writeFileSync(h.artifacts.proposals, broken);
    const r = await council([...HARVEST, "--out", out, "--json"]);
    assert.equal(r.code, 2);
    assert.match(summary(r).errors[0].message, /isn't valid JSON/);
    assert.equal(readFileSync(h.artifacts.proposals, "utf8"), broken);
  });

  it("keeps a decided proposal that a narrower harvest doesn't propose again", async () => {
    const out = tmp();
    const h = summary(await council([...HARVEST, "--out", out, "--json"]));
    decide(h.artifacts.proposals, { "render queue": { decision: "decline", why: "We keep this one free." } });
    const keys = join(out, "keys.txt");
    writeFileSync(keys, "ui.layer.add\nui.layer.delete\n");
    const narrow = summary(await council([...HARVEST, "--keys-file", keys, "--out", out, "--json"]));
    assert.equal(narrow.counts.stale, 1);
    const doc = readJson(narrow.artifacts.proposals);
    const kept = doc.proposals.find((p) => p.id === "render queue");
    assert.equal(kept.decision, "decline");
    assert.equal(kept.stale, true);
    const full = readJson(summary(await council([...HARVEST, "--out", out, "--json"])).artifacts.proposals);
    const back = full.proposals.find((p) => p.id === "render queue");
    assert.equal(back.decision, "decline");
    assert.equal(back.stale, undefined);
  });

  it("sets empty or unbacked extractor answers aside instead of failing", () => {
    const { observations, unverified } = verifyTerms([
      { key: "a", source: "Add layer", candidate: "Hinzufügen", terms: [{ source: "layer", target: "", base: "", productMeaning: "" }] },
    ]);
    assert.equal(observations.length, 0);
    assert.equal(unverified[0].reason, "empty_term");
  });

  it("warns when no profile was given and the mock extractor ran", async (t) => {
    if (process.env.COUNCIL_PROFILE || process.env.COUNCIL_PROVIDER) return t.skip("a profile is set in the environment");
    const s = summary(await council([...HARVEST.slice(0, -1), "--out", tmp(), "--json"]));
    assert.equal(s.warnings[0].code, "mock_profile_default");
  });

  it("rejects bad flags and a glossary for another locale with exit 2", async () => {
    assert.equal((await council(["glossary", "--json"])).code, 2);
    assert.equal((await council(["glossary", "prune", "--json"])).code, 2);
    assert.equal((await council([...HARVEST, "--write", "--json"])).code, 2);
    assert.equal((await council([...HARVEST, "--min-keys", "0", "--out", tmp(), "--json"])).code, 2);
    const r = await council([...harvestArgs({ locale: "fr" }), "--out", tmp(), "--json"]);
    assert.equal(r.code, 2);
    const s = summary(r);
    assert.equal(s.action, "harvest");
    assert.deepEqual(s.proposals, []);
    assert.equal((await council([...HARVEST, "--extractor", "api:jev", "--out", tmp(), "--json"])).code, 2);
    for (const action of ["constructor", "toString", "__proto__"]) {
      const bad = await council(["glossary", action, "--json"]);
      assert.equal(bad.code, 2, action);
      assert.equal(summary(bad).action, null);
    }
    assert.equal((await council(["constructor", "--json"])).code, 2);
    assert.equal((await council([...HARVEST, "--preset", "budget", "--out", tmp(), "--json"])).code, 2, "a preset can't change the mock extractor");
    assert.equal((await council([...HARVEST, "--catalog", "x", "--help"])).code, 0, "help ignores other flags");
  });
});

describe("council glossary apply", () => {
  it("approves, declines and leaves undecided proposals pending; writes glossary.next.json and affected keys", async () => {
    const out = tmp();
    const h = summary(await council([...HARVEST, "--out", out, "--json"]));
    decide(h.artifacts.proposals, {
      keyframe: { decision: "approve", reject: ["Schlüsselbild"] },
      layer: { decision: "approve" },
      "render queue": { decision: "decline", why: "We keep this one free." },
    });
    const r = await council(["glossary", "apply", "--proposals", h.artifacts.proposals, "--glossary", join(G, "glossary.de.json"), "--json"]);
    assert.equal(r.code, 0);
    const s = summary(r);
    assert.equal(s.status, "applied");
    assert.equal(s.written, "next_file");
    assert.deepEqual([s.counts.approved, s.counts.declined, s.counts.pending, s.counts.entries], [2, 1, 0, 4]);
    const next = validateGlossary(readJson(s.artifacts.glossary));
    const keyframe = next.entries.find((e) => e.source === "keyframe");
    assert.equal(keyframe.practitionerTerm, "Keyframe");
    assert.deepEqual(keyframe.rejected, [{ term: "Schlüsselbild", why: 'Use "Keyframe" (approved in glossary review).' }]);
    assert.deepEqual(keyframe.origin, { via: "harvest", keys: ["ui.keyframe.add", "ui.keyframe.delete", "ui.keyframe.ease"] });
    assert.deepEqual(next.declined.map((d) => d.source), ["viewport", "render queue"]);
    assert.deepEqual(readJson(s.artifacts.affectedKeys).keys, [
      "ui.keyframe.add",
      "ui.keyframe.delete",
      "ui.keyframe.ease",
      "ui.layer.add",
      "ui.layer.delete",
      "ui.layer.rename",
    ]);
    assert.equal(readJson(join(G, "glossary.de.json")).entries.length, 2, "without --write the glossary is untouched");

    // The grown glossary is the council's resource from here on: harvest stops proposing these
    // terms, and tidy reopens the shipped string that uses the rejected rendering.
    const after = summary(await council([...harvestArgs({ glossary: s.artifacts.glossary }), "--out", out, "--json"]));
    assert.equal(after.status, "clean");
    assert.equal(after.counts.inGlossary, 4);
    const tidy = summary(
      await council([
        "tidy",
        "--catalog",
        join(G, "en.json"),
        "--locale-file",
        join(G, "de.json"),
        "--locale",
        "de",
        "--glossary",
        s.artifacts.glossary,
        "--keys-file",
        s.artifacts.affectedKeys,
        "--generate-bt",
        "--profile=mock",
        "--out",
        join(out, "tidy"),
        "--json",
      ]),
    );
    assert.deepEqual(tidy.reopen, [{ key: "ui.keyframe.ease", why_bucket: "glossary" }]);
  });

  it("--write updates the glossary in place, and starts a new one when the file doesn't exist", async () => {
    const out = tmp();
    const h = summary(await council([...HARVEST, "--out", out, "--json"]));
    decide(h.artifacts.proposals, { layer: { decision: "approve" } });
    const g = join(out, "glossary.de.json");
    copyFileSync(join(G, "glossary.de.json"), g);
    const r = await council(["glossary", "apply", "--proposals", h.artifacts.proposals, "--glossary", g, "--write", "--json"]);
    assert.equal(r.code, 10); // two proposals are still undecided
    const s = summary(r);
    assert.equal(s.written, "in_place");
    assert.equal(s.status, "proposals");
    assert.equal(s.proposals.length, 2);
    assert.equal(readJson(g).entries.length, 3);

    const fresh = join(out, "new", "glossary.de.json");
    const n = summary(await council(["glossary", "apply", "--proposals", h.artifacts.proposals, "--glossary", fresh, "--write", "--json"]));
    assert.equal(n.newGlossary, true);
    assert.deepEqual(readJson(fresh).entries.map((e) => e.source), ["layer"]);
    assert.equal(readJson(fresh).locale, "de");
  });

  it("refuses contradictory or malformed decisions with exit 2 and changes nothing", async () => {
    const out = tmp();
    const h = summary(await council([...HARVEST, "--out", out, "--json"]));
    const g = join(out, "g.json");
    copyFileSync(join(G, "glossary.de.json"), g);
    const before = readFileSync(g, "utf8");
    for (const bad of [
      { keyframe: { decision: "approve", reject: ["keyframe"] } },
      { keyframe: { decision: "approve", practitionerTerm: "Vorkeyframe", reject: ["Keyframe"] } },
      { keyframe: { decision: "yes" } },
      { keyframe: { decision: "approve", practitionerTerm: " " } },
    ]) {
      decide(h.artifacts.proposals, { keyframe: { decision: null, reject: [], practitionerTerm: "Keyframe" }, ...bad });
      const r = await council(["glossary", "apply", "--proposals", h.artifacts.proposals, "--glossary", g, "--write", "--json"]);
      assert.equal(r.code, 2, JSON.stringify(bad));
      assert.equal(readFileSync(g, "utf8"), before);
    }
    decide(h.artifacts.proposals, { keyframe: { decision: "approve", reject: [], practitionerTerm: "Keyframe" } });
    const stray = await council(["glossary", "apply", "--proposals", h.artifacts.proposals, "--glossary", g, "--write", "false", "--json"]);
    assert.equal(stray.code, 2, '"--write false" is refused, not read as --write');
    assert.equal(readFileSync(g, "utf8"), before);
    writeFileSync(join(out, "other.json"), "{}");
    assert.equal((await council(["glossary", "apply", "--proposals", join(out, "other.json"), "--glossary", g, "--json"])).code, 2);
  });

  it("skips a term someone already added by hand", () => {
    const glossary = readJson(join(G, "glossary.de.json"));
    const doc = {
      schema: "council.glossary-proposals.v1",
      locale: "de",
      proposals: [{ id: "compositions", source: "Compositions", practitionerTerm: "Komposition", decision: "approve", reject: [] }],
    };
    const r = applyProposals(glossary, doc);
    assert.deepEqual(r.skipped, [{ source: "Compositions", decision: "approve", reason: 'already in the glossary as "composition"' }]);
    assert.equal(r.glossary.entries.length, 2);
    // A related term counts too, but a longer word that merely starts the same doesn't.
    const related = applyProposals(glossary, { ...doc, proposals: [{ ...doc.proposals[0], id: "comp", source: "comp" }] });
    assert.equal(related.skipped.length, 1);
    const card = { schemaVersion: "0", locale: "de", entries: [{ ...glossary.entries[0], source: "car", practitionerTerm: "Auto", relatedTerms: [], rejected: [] }] };
    const r2 = applyProposals(card, { ...doc, proposals: [{ id: "card", source: "card", practitionerTerm: "Karte", decision: "approve", reject: [] }] });
    assert.deepEqual(r2.approved, ["card"]);
  });

  it("reports approvals it skipped instead of claiming nothing happened", async () => {
    const out = tmp();
    const h = summary(await council([...HARVEST, "--out", out, "--json"]));
    decide(h.artifacts.proposals, { layer: { decision: "approve", source: "Compositions" } });
    const s = summary(await council(["glossary", "apply", "--proposals", h.artifacts.proposals, "--glossary", join(G, "glossary.de.json"), "--json"]));
    assert.equal(s.status, "proposals");
    assert.deepEqual(s.skipped.map((x) => x.source), ["Compositions"]);
    assert.equal(s.warnings[0].code, "approval_skipped");
    assert.equal(s.artifacts.affectedKeys, null, "nothing approved, so no affected-keys.json");
    assert.equal(existsSync(join(out, "affected-keys.json")), false);
  });

  it("mergeDecisions matches a term across spellings", () => {
    const { proposals, kept } = mergeDecisions(
      [{ id: "layer", source: "layer", practitionerTerm: "Ebene", productMeaning: "", decision: null, reject: [], why: "" }],
      { proposals: [{ id: "layers", source: "layers", suggested: { source: "layers" }, decision: "decline", why: "generic" }] },
    );
    assert.equal(kept, 1);
    assert.equal(proposals[0].decision, "decline");
    assert.equal(proposals[0].source, "layer");
  });
});

describe("harvest parity: mock / openrouter / fleet", () => {
  const saved = {};
  let server;
  before(async () => {
    server = await startFakeOpenRouter();
    for (const [k, v] of Object.entries({
      CLAUDE_CLI_BIN: join(FIX, "fake-claude.mjs"),
      GROK_CLI_BIN: join(FIX, "fake-grok.mjs"),
      CODEX_CLI_BIN: join(FIX, "fake-codex.mjs"),
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_BASE_URL: server.url,
    })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    await server.close();
  });

  it("every profile proposes the same terms, with the profile's judge as extractor", async () => {
    const results = {};
    for (const profile of ["mock", "openrouter", "fleet"]) {
      const s = summary(await council([...harvestArgs({ profile }), "--out", tmp(), "--json"]));
      results[profile] = s;
    }
    assert.equal(results.openrouter.extractor, "openrouter:openai/gpt-5.6-sol");
    assert.equal(results.fleet.extractor, "cli:codex");
    for (const profile of ["openrouter", "fleet"]) {
      assert.deepEqual(results[profile].proposals, results.mock.proposals, profile);
      assert.deepEqual(Object.keys(results[profile]).sort(), Object.keys(results.mock).sort(), profile);
    }
    assert.ok(server.requests.some((r) => r.body.response_format?.json_schema?.name === "council_terms"));
  });
});
