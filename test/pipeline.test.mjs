import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCouncil } from "../src/index.mjs";
import { validate, validateDef } from "../src/json-schema.mjs";
import { runStage } from "../src/pipeline/stage.mjs";
import { createRunContext } from "../src/run-context.mjs";
import { createMockAdapter } from "../src/providers/mock.mjs";
import {
  consensusCullStage,
  faceoffDecision,
  labelOptions,
} from "../src/pipeline/post-escalate.mjs";
import { candidateReasons, renderReport } from "../src/pipeline/escalate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const TOY = join(ROOT, "fixtures", "toy");
const tmp = (p) => mkdtempSync(join(tmpdir(), `lc-${p}-`));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function assertRunSummary(s) {
  const env = validate(s, "summary.v1.json");
  assert.ok(env.ok, env.errors.join("; "));
  const run = validateDef(s, "summary.v1.json", "run");
  assert.ok(run.ok, run.errors.join("; "));
}

const base = {
  catalog: join(TOY, "en.json"),
  locale: "de",
  glossary: join(TOY, "glossary.de.json"),
  profile: "mock",
};

describe("runCouncil (mock profile)", () => {
  it("escalates the three fluent mistakes and accepts the rest", async () => {
    const out = tmp("run");
    const s = await runCouncil({ ...base, out });
    assertRunSummary(s);
    assert.equal(s.status, "escalations");
    assert.equal(s.exitCode, 10);
    assert.deepEqual(s.escalations.map((e) => e.key).sort(), ["ui.layer.precomp", "ui.status.rendering", "ui.viewport.onion"]);
    assert.equal(s.counts.accepted, 17);
    for (const f of Object.values(s.artifacts)) assert.ok(existsSync(f), f);

    const esc = readJson(join(out, "escalate.json"));
    const onion = esc.items.find((i) => i.key === "ui.viewport.onion");
    assert.equal(onion.candidate, "Zwiebelschale");
    assert.equal(onion.backtranslation, "Onion skin");
    assert.ok(onion.reasons.includes("glossary_violation"));

    const accepted = readJson(join(out, "accepted.json"));
    assert.equal(Object.keys(accepted.strings).length, 17);
    assert.equal(accepted.strings["ui.timeline.play"], "Abspielen");
    assert.ok(!("ui.viewport.onion" in accepted.strings));

    const manifest = readJson(join(out, "manifest.json"));
    const mv = validate(manifest, "manifest.v1.json");
    assert.ok(mv.ok, mv.errors.join("; "));
    assert.equal(manifest.profile, "mock");
    assert.equal(manifest.thresholds.meaning, 0.75);
    assert.match(manifest.glossary.version, /^sha256:/);
    assert.equal(manifest.tools.node, process.version);

    assert.match(readFileSync(join(out, "report.md"), "utf8"), /Zwiebelschale/);
  });

  it("reruns hit the cache for every stage; --no-cache does not", async () => {
    const out = tmp("cache");
    await runCouncil({ ...base, out });
    const again = await runCouncil({ ...base, out });
    assert.equal(again.counts.cacheHits, 60);
    const manifest = readJson(join(out, "manifest.json"));
    assert.deepEqual(manifest.cache.hits, { translate: 20, backtranslate: 20, judge: 20 });
    const fresh = await runCouncil({ ...base, out, cache: false });
    assert.equal(fresh.counts.cacheHits, 0);
  });

  it("the cache key includes the glossary version", async () => {
    const out = tmp("gv");
    await runCouncil({ ...base, out });
    const g = readJson(base.glossary);
    g.version = "2";
    const gPath = join(out, "glossary.v2.json");
    writeFileSync(gPath, JSON.stringify(g));
    const s = await runCouncil({ ...base, glossary: gPath, out });
    // translate + judge see the glossary; blind back-translation does not
    assert.equal(s.counts.cacheHits, 20);
  });

  it("--meaning-threshold changes what escalates", async () => {
    const s = await runCouncil({ ...base, out: tmp("thr"), meaningThreshold: 0.5 });
    assert.deepEqual(s.escalations.map((e) => e.key).sort(), ["ui.layer.precomp", "ui.viewport.onion"]);
  });

  it("--target limits the run to missing/untranslated keys; nothing to do is clean and quiet", async () => {
    const s = await runCouncil({ ...base, out: tmp("delta"), target: join(TOY, "de.json") });
    assert.equal(s.counts.keys, 10); // 9 missing + "Pause" identical to source
    const done = tmp("done");
    const full = Object.fromEntries(Object.keys(readJson(join(TOY, "en.json"))).map((k) => [k, `x-${k}`]));
    writeFileSync(join(done, "de.json"), JSON.stringify(full));
    const skipped = await runCouncil({ ...base, out: join(done, "out"), target: join(done, "de.json") });
    assertRunSummary(skipped);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.exitCode, 0);
    assert.equal(existsSync(join(done, "out")), false);
  });

  it("rejects a glossary for another locale", async () => {
    await assert.rejects(() => runCouncil({ ...base, locale: "fr", out: tmp("gl") }), /does not match run locale/);
  });

  it("--strict-diversity fails before any provider call", async () => {
    await assert.rejects(
      () =>
        runCouncil({
          ...base,
          profile: undefined,
          provider: "translate=cli:claude,backtranslate=cli:claude,judge=cli:codex",
          strictDiversity: true,
          out: tmp("div"),
        }),
      /strict-diversity.*both anthropic/,
    );
  });
});

describe("post-escalate stages (mock profile)", () => {
  it("faceoff → consensus cull → blind audit each settle one row", async () => {
    const out = tmp("post");
    const s = await runCouncil({ ...base, out, faceoff: true, consensusCull: true, blindAudit: true });
    assertRunSummary(s);
    assert.equal(s.status, "clean");
    assert.equal(s.exitCode, 0);
    assert.equal(s.counts.initialEscalations, 3);
    assert.equal(s.counts.resolvedByFaceoff, 1);
    assert.equal(s.counts.resolvedByConsensusCull, 1);
    assert.equal(s.counts.resolvedByBlindAudit, 1);

    const accepted = readJson(join(out, "accepted.json"));
    assert.equal(accepted.strings["ui.layer.precomp"], "Vorkomponieren");
    assert.equal(accepted.via["ui.layer.precomp"], "faceoff");
    assert.equal(accepted.strings["ui.viewport.onion"], "Onion Skin");
    assert.equal(accepted.via["ui.viewport.onion"], "consensus_cull");
    assert.equal(accepted.strings["ui.status.rendering"], "Wird gerendert…");
    assert.equal(accepted.via["ui.status.rendering"], "blind_audit");

    const esc = readJson(join(out, "escalate.json"));
    assert.equal(esc.count, 0);
    assert.equal(esc.resolved.length, 3);

    const dir = join(out, "blind-audit");
    for (const f of ["blind-items.json", "reveal.json", "summary.json", "BLIND-AUDIT.md"]) {
      assert.ok(existsSync(join(dir, f)), f);
    }
    const items = readFileSync(join(dir, "blind-items.json"), "utf8");
    assert.doesNotMatch(items, /mock/, "judges must not see provider names");
    const summary = readJson(join(dir, "summary.json"));
    assert.equal(summary.rows[0].status, "consensus");
    assert.equal(readJson(join(dir, "reveal.json")).seed, summary.seed);
  });

  it("without the cull, near-ties stay escalated with a trail", async () => {
    const out = tmp("faceoff-only");
    const s = await runCouncil({ ...base, out, faceoff: true });
    assert.equal(s.counts.resolvedByFaceoff, 1);
    assert.equal(s.counts.escalated, 2);
    const esc = readJson(join(out, "escalate.json"));
    assert.ok(esc.items.every((i) => i.postEscalate.includes("faceoff:near_tie")));
  });

  it("with --blind-audit but no cull, agreeing near-ties are recorded as skipped, not dropped", async () => {
    const out = tmp("audit-skip");
    const s = await runCouncil({ ...base, out, faceoff: true, blindAudit: true });
    const summary = readJson(join(out, "blind-audit", "summary.json"));
    assert.equal(summary.skipped, 1, "onion skin: both alternatives say 'Onion Skin'");
    assert.ok(summary.rows.some((r) => r.key === "ui.viewport.onion" && r.status === "skipped_single_option"));
    assert.ok(s.escalations.some((e) => e.key === "ui.viewport.onion"), "it stays with a person");
  });

  it("skips empty English strings with a warning instead of failing the run", async () => {
    const dir = tmp("empty");
    writeFileSync(join(dir, "en.json"), JSON.stringify({ a: "Play", b: "", c: "   " }));
    const s = await runCouncil({ catalog: join(dir, "en.json"), locale: "de", profile: "mock", out: join(dir, "out") });
    assert.equal(s.counts.keys, 1);
    assert.ok(s.warnings.some((w) => w.code === "empty_source_skipped"));
  });

  it("a larger margin turns the faceoff win into a near-tie", async () => {
    const s = await runCouncil({ ...base, out: tmp("margin"), faceoff: true, faceoffMargin: 0.99 });
    assert.equal(s.counts.resolvedByFaceoff, 0);
  });

  it("the seed makes the blind shuffle reproducible", () => {
    const texts = ["a", "b", "c", "d"];
    assert.deepEqual(labelOptions(texts, 42, "k"), labelOptions(texts, 42, "k"));
    const seen = new Set();
    for (let seed = 0; seed < 20; seed++) seen.add(JSON.stringify(labelOptions(texts, seed, "k")));
    assert.ok(seen.size > 1, "different seeds should give different shuffles");
  });
});

describe("faceoffDecision", () => {
  const c = (provider, meaning, eligible = true, text = provider) => ({ provider, text, meaning, fluency: 0.9, eligible });

  it("wins on a clear margin over the next acceptable candidate", () => {
    const d = faceoffDecision([c("a", 0.95), c("b", 0.85), c("bad", 0.99, false)], 0.05);
    assert.equal(d.status, "won");
    assert.equal(d.winner.provider, "a");
    assert.equal(d.margin, 0.1);
  });

  it("treats exactly the margin as a win (float-safe)", () => {
    assert.equal(faceoffDecision([c("a", 0.95), c("b", 0.9)], 0.05).status, "won");
  });

  it("near-tie below the margin", () => {
    assert.equal(faceoffDecision([c("a", 0.95), c("b", 0.93)], 0.05).status, "near_tie");
  });

  it("no acceptable candidate", () => {
    assert.equal(faceoffDecision([c("a", 0.95, false)], 0.05).status, "no_valid_candidate");
  });
});

describe("consensusCullStage", () => {
  const cand = (provider, text, eligible) => ({ provider, text, meaning: 0.9, eligible, glossaryOk: eligible, icuOk: true, protectedTokensOk: true });

  it("accepts identical text from ≥ 2 candidates when it passes every check", () => {
    const r = consensusCullStage(
      [{ key: "k", status: "near_tie", candidates: [cand("a", "Onion Skin", true), cand("b", "Onion  Skin", true), cand("c", "Other", true)] }],
      { consensusMin: 2 },
    );
    assert.equal(r.rows[0].status, "accepted");
    assert.deepEqual(r.rows[0].agreeing, ["a", "b"]);
  });

  it("never accepts identical text that fails a check", () => {
    const r = consensusCullStage(
      [{ key: "k", status: "near_tie", candidates: [cand("a", "Zwiebelschale", false), cand("b", "Zwiebelschale", false), cand("c", "Onion Skin", true)] }],
      { consensusMin: 2 },
    );
    assert.equal(r.rows[0].status, "divergent");
  });

  it("an even split between agreeing groups (2 vs 2) is divergent, not settled by score", () => {
    const r = consensusCullStage(
      [
        {
          key: "k",
          status: "near_tie",
          candidates: [
            { ...cand("a", "A", true), meaning: 0.95 },
            { ...cand("b", "A", true), meaning: 0.95 },
            { ...cand("c", "B", true), meaning: 0.94 },
            { ...cand("d", "B", true), meaning: 0.94 },
          ],
        },
      ],
      { consensusMin: 2 },
    );
    assert.equal(r.rows[0].status, "divergent");
  });

  it("respects --consensus-min", () => {
    const rows = [{ key: "k", status: "near_tie", candidates: [cand("a", "x", true), cand("b", "x", true)] }];
    assert.equal(consensusCullStage(rows, { consensusMin: 3 }).rows[0].status, "divergent");
  });
});

describe("candidateReasons", () => {
  it("flags rejected glossary terms even when the judge missed them", () => {
    const glossary = readJson(join(TOY, "glossary.de.json"));
    const reasons = candidateReasons({
      candidate: { key: "k", source: "Onion skin", candidate: "Zwiebelschale" },
      score: { meaning: 0.95, glossaryOk: true, escalate: false },
      glossary,
    });
    assert.deepEqual(reasons, ["glossary_rejected_term:Zwiebelschale"]);
  });
});

describe("runStage resumes after an interruption", () => {
  it("only unfinished items go to the provider on the rerun", async () => {
    const out = tmp("resume");
    const mock = createMockAdapter("mock");
    let calls = 0;
    const flaky = {
      ...mock,
      batchSize: () => 2,
      async translate(batch, ctx) {
        calls += 1;
        if (calls === 2) throw new Error("provider crashed");
        return mock.translate(batch, ctx);
      },
    };
    const items = ["Play", "Pause", "Duration", "Ready"].map((source, i) => ({ key: `k${i}`, source }));
    const ctx1 = await createRunContext({ outDir: out });
    await assert.rejects(() => runStage({ stage: "translate", adapter: flaky, locale: "de", items, ctx: ctx1 }), /crashed/);

    const seen = [];
    const counting = {
      ...mock,
      batchSize: () => 2,
      async translate(batch, ctx) {
        seen.push(...batch.items.map((i) => i.key));
        return mock.translate(batch, ctx);
      },
    };
    const ctx2 = await createRunContext({ outDir: out });
    const rows = await runStage({ stage: "translate", adapter: counting, locale: "de", items, ctx: ctx2 });
    assert.deepEqual(seen, ["k2", "k3"]);
    assert.deepEqual(rows.map((r) => r.candidate), ["Abspielen", "Pause", "Dauer", "Bereit"]);
  });
});

describe("renderReport", () => {
  it("escapes backslashes before pipes so table cells can't break out", () => {
    const md = renderReport({
      locale: "de",
      profile: "mock",
      providers: { translate: "mock", backtranslate: "mock", judge: "mock" },
      candidates: [{ key: "k", source: "a\\|b", candidate: "c|d" }],
      scores: [{ key: "k", meaning: 0.5, glossaryOk: true, escalate: false }],
      escalation: {
        threshold: 0.75,
        count: 1,
        items: [{ key: "k", source: "a\\|b", candidate: "c|d", backtranslation: "x", meaning: 0.5, reasons: ["low_meaning:0.5"] }],
      },
    });
    const row = md.split("\n").find((l) => l.startsWith("| `k` |") && l.includes("low_meaning"));
    assert.ok(row.includes("a\\\\\\|b"), row);
    assert.ok(row.includes("c\\|d"), row);
  });
});
