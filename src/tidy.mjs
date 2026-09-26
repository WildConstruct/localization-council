/**
 * `council tidy`: re-audit strings that already shipped, without
 * retranslating. Useful when a better judge or a new glossary arrives.
 *
 * The judge is configurable:
 *   - any judge provider (mock, cli:*, openrouter:*) re-scores the shipped
 *     candidate against its blind back-translation; a row reopens when it
 *     would fail today's council checks
 *   - api:jev asks typed tidy questions (reopen / why_bucket / priority)
 *
 * Back-translations come from --bt-file (a prior run's backtranslations.json)
 * or, with --generate-bt, from the profile's back-translate provider. Rows
 * with no back-translation reopen for a human; the council never invents one.
 *
 * Output under --out: tidy.json, tidy.csv, SUMMARY.md, manifest.json.
 * Exit 10 when any row reopens. Nothing is merged.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadCatalog } from "./catalog.mjs";
import { loadGlossary } from "./glossary.mjs";
import { loadModelsConfig, applyModelSelection, councilVersion, expandStageSpec } from "./config.mjs";
import { resolveRunProviders, createAdapter, supportedStages, isKnownProvider } from "./providers/resolve.mjs";
import { jevDecide, JEV_DEFAULT_MODEL } from "./providers/jev-openrouter.mjs";
import { runStage } from "./pipeline/stage.mjs";
import { structureChecks } from "./pipeline/translate.mjs";
import { candidateReasons, DEFAULT_MEANING_THRESHOLD } from "./pipeline/escalate.mjs";
import { createRunContext, glossaryVersion, glossaryHash } from "./run-context.mjs";
import { toolVersions } from "./doctor.mjs";
import { envelope, EXIT, UsageError } from "./summary.mjs";
import { numberOption } from "./options.mjs";
import {
  buildTidyQuestions,
  buildTidyState,
  mapTidyAnswers,
  buildTidyRow,
  tidyRowsToCsv,
  selectTidyKeys,
  loadBtMap,
  loadBtCandidates,
  TIDY_BT_MISSING,
} from "./tidy-audit.mjs";
import { normalizeCandidateText } from "./providers/contract.mjs";

const JEV_IDS = new Set(["api:jev", "jev"]);

/** Parse a keys file: JSON array / { keys: [] } / object keys, or one key per line. */
export function parseKeysFile(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const doc = JSON.parse(trimmed);
    if (Array.isArray(doc)) return doc.map(String);
    if (Array.isArray(doc.keys)) return doc.keys.map(String);
    return Object.keys(doc);
  }
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function btMissingDecision(model) {
  return {
    reopen: true,
    why_bucket: "other",
    priority: "",
    confidence_min: "",
    model,
    cost: 0,
    note: "bt_missing: no back-translation of the current wording (none in --bt-file, or it was made from an older candidate); pass a fresh --bt-file or use --generate-bt",
  };
}

/**
 * Jev tidy loop (typed reopen / why_bucket / priority questions).
 * Exported for tests with an injectable decideFn.
 */
export async function runTidyAudit({
  enMap,
  localeMap,
  locale,
  glossary = null,
  btMap = {},
  keys = null,
  limit = null,
  decideFn = null,
  model = null,
  apiKey = undefined,
  fetchImpl = undefined,
  ctx = null,
} = {}) {
  const selected = selectTidyKeys(enMap, localeMap, { keys, limit });
  const resolvedModel = model || process.env.JEV_MODEL || JEV_DEFAULT_MODEL;
  const questions = buildTidyQuestions({ includePriority: true });
  const rows = [];
  let cost = 0;
  let reopenCount = 0;
  let skippedBt = 0;
  let modelId = resolvedModel;

  for (const item of selected) {
    const bt = btMap[item.key];
    if (bt == null || String(bt).trim() === "") {
      skippedBt += 1;
      reopenCount += 1;
      const decision = btMissingDecision(resolvedModel);
      rows.push(buildTidyRow({ ...item, locale, backtranslation: TIDY_BT_MISSING, decision, note: decision.note }));
      continue;
    }
    const checks = structureChecks(item.en, item.candidate, locale);
    const state = buildTidyState({
      key: item.key,
      locale,
      en: item.en,
      candidate: item.candidate,
      backtranslation: bt,
      glossary,
      icuOk: checks.icuOk,
      icuMissing: checks.icuMissing,
      icuExtras: checks.icuExtras,
    });
    const decide = typeof decideFn === "function" ? decideFn : jevDecide;
    const opts = { model: resolvedModel };
    if (apiKey !== undefined) opts.apiKey = apiKey;
    if (fetchImpl) opts.fetchImpl = fetchImpl;
    const json = await decide(state, questions, opts);
    modelId = json.model || resolvedModel;
    ctx?.telemetry?.record({
      stage: "judge",
      provider: "api:jev",
      requestedModel: resolvedModel,
      resolvedModel: modelId,
      costUsd: Number.isFinite(Number(json.usage?.cost)) ? Number(json.usage.cost) : null,
    });
    const decision = mapTidyAnswers(json.answers, { key: item.key, model: modelId, usage: json.usage });
    cost += decision.cost || 0;
    if (decision.reopen) reopenCount += 1;
    rows.push(buildTidyRow({ ...item, locale, backtranslation: bt, decision }));
  }
  return { rows, reopenCount, cost, modelId, skippedBt, total: rows.length };
}

function whyBucket(reasons) {
  if (!reasons.length) return "fine";
  if (reasons.some((r) => r.startsWith("icu_") || r.startsWith("protected_tokens"))) return "icu";
  if (reasons.some((r) => r.startsWith("glossary"))) return "glossary";
  if (reasons.some((r) => r.startsWith("low_meaning"))) return "meaning";
  return "other";
}

/**
 * Judge-provider tidy loop: re-score each shipped candidate with any judge.
 */
export async function runJudgeTidy({ selected, locale, glossary, btMap, adapter, ctx, meaningThreshold }) {
  const withBt = selected.filter((s) => btMap[s.key] != null && String(btMap[s.key]).trim() !== "");
  const verdicts = await runStage({
    stage: "judge",
    adapter,
    locale,
    glossary,
    items: withBt.map((s) => ({ key: s.key, source: s.en, candidate: s.candidate, backtranslation: btMap[s.key] })),
    ctx,
  });
  const byKey = new Map(verdicts.map((v) => [v.key, v]));
  const rows = [];
  let reopenCount = 0;
  let skippedBt = 0;
  for (const item of selected) {
    const v = byKey.get(item.key);
    if (!v) {
      skippedBt += 1;
      reopenCount += 1;
      const decision = btMissingDecision(adapter.describe("judge").model);
      rows.push(buildTidyRow({ ...item, locale, backtranslation: TIDY_BT_MISSING, decision, note: decision.note }));
      continue;
    }
    const candidate = { key: item.key, source: item.en, candidate: item.candidate, ...structureChecks(item.en, item.candidate, locale) };
    const reasons = candidateReasons({ candidate, score: v, glossary, meaningThreshold });
    const decision = {
      reopen: reasons.length > 0,
      why_bucket: whyBucket(reasons),
      priority: "",
      confidence_min: "",
      model: v.model || adapter.describe("judge").model,
      cost: 0,
      note: reasons.length ? `${reasons.join("; ")} | ${v.rationale}` : v.rationale,
    };
    if (decision.reopen) reopenCount += 1;
    rows.push(buildTidyRow({ ...item, locale, backtranslation: btMap[item.key], decision }));
  }
  return { rows, reopenCount, skippedBt, total: rows.length };
}

/**
 * Run `council tidy` and return its summary.
 * @param {object} opts - see `council help tidy`
 */
export async function runTidy(opts) {
  const startedAt = new Date();
  for (const f of ["catalog", "localeFile", "locale"]) {
    if (!opts[f]) throw new UsageError(`tidy requires --${f === "localeFile" ? "locale-file" : f}`);
  }
  const stageModels = Object.fromEntries(Object.entries(opts.stageModels || {}).filter(([, v]) => v != null));
  let preset = opts.preset || null;
  const models = applyModelSelection(loadModelsConfig({ modelsFile: opts.modelsFile }), { preset, stageModels });
  const run = resolveRunProviders({ mock: opts.mock, provider: opts.provider, profile: opts.profile, models });
  if ((preset || Object.keys(stageModels).length) && !Object.values(run.providers).some((p) => p.startsWith("openrouter:"))) {
    // COUNCIL_PRESET in the environment is a default for OpenRouter runs, not an error for mock/fleet runs.
    if (opts.presetSource !== "env" || Object.keys(stageModels).length) {
      throw new UsageError("--preset/--*-model only affect OpenRouter stages; use --profile=openrouter");
    }
    preset = null;
  }
  const judgeId = opts.judge ? expandStageSpec(opts.judge, "judge", models) : run.providers.judge;
  if (!isKnownProvider(judgeId)) throw new UsageError(`Unknown judge "${opts.judge}"`);
  if (!supportedStages(judgeId).includes("judge")) throw new UsageError(`${judgeId} cannot judge`);

  const enMap = await loadCatalog(opts.catalog);
  const localeMap = await loadCatalog(opts.localeFile);
  const glossary = opts.glossary ? await loadGlossary(opts.glossary) : null;
  const keys = opts.keysFile ? parseKeysFile(await readFile(opts.keysFile, "utf8")) : null;
  const limit = numberOption(opts.limit, "--limit", null, { min: 0, integer: true });
  const meaningThreshold = numberOption(opts.meaningThreshold, "--meaning-threshold", DEFAULT_MEANING_THRESHOLD, {
    min: 0,
    max: 1,
  });
  const btRaw = opts.btFile ? JSON.parse(await readFile(opts.btFile, "utf8")) : null;
  let btMap = btRaw ? loadBtMap(btRaw) : {};
  const btCandidates = btRaw ? loadBtCandidates(btRaw) : {};

  const outDir = resolve(opts.out || `./scores/${opts.locale}-tidy`);
  await mkdir(outDir, { recursive: true });
  const tools = await toolVersions(new Set([judgeId, ...(opts.generateBt ? [run.providers.backtranslate] : [])]), models);
  const providerSalt = Object.fromEntries(
    Object.values(tools.cli).map((t) => [`cli:${t.name}`, `${t.name}@${t.version ?? "unknown"}`]),
  );
  const ctx = await createRunContext({ outDir, cacheDir: opts.cacheDir, cache: opts.cache !== false, providerSalt });
  const adapterOpts = { models, fetchImpl: opts.fetchImpl };

  const selected = selectTidyKeys(enMap, localeMap, { keys, limit });
  // A back-translation made from an older wording says nothing about the shipped string.
  let staleBt = 0;
  for (const s of selected) {
    const from = btCandidates[s.key];
    if (from != null && btMap[s.key] != null && normalizeCandidateText(from) !== normalizeCandidateText(s.candidate)) {
      delete btMap[s.key];
      staleBt += 1;
    }
  }
  let generatedBt = 0;
  if (opts.generateBt) {
    const missing = selected.filter((s) => btMap[s.key] == null || String(btMap[s.key]).trim() === "");
    if (missing.length) {
      const btAdapter = createAdapter(run.providers.backtranslate, adapterOpts);
      const bts = await runStage({
        stage: "backtranslate",
        adapter: btAdapter,
        locale: opts.locale,
        items: missing.map((s) => ({ key: s.key, candidate: s.candidate })),
        ctx,
      });
      btMap = { ...btMap, ...Object.fromEntries(bts.map((b) => [b.key, b.backtranslation])) };
      generatedBt = bts.length;
    }
  }

  let result;
  if (JEV_IDS.has(judgeId)) {
    result = await runTidyAudit({
      enMap,
      localeMap,
      locale: opts.locale,
      glossary,
      btMap,
      keys,
      limit,
      fetchImpl: opts.fetchImpl,
      ctx,
    });
  } else {
    result = await runJudgeTidy({
      selected,
      locale: opts.locale,
      glossary,
      btMap,
      adapter: createAdapter(judgeId, adapterOpts),
      ctx,
      meaningThreshold,
    });
  }

  await ctx.settle();
  const telemetry = ctx.telemetry.summary();
  const tidyDoc = {
    locale: opts.locale,
    judge: judgeId,
    model: result.modelId || null,
    costUsd: telemetry.costUsd,
    reopenCount: result.reopenCount,
    skippedBt: result.skippedBt,
    staleBt,
    generatedBt,
    total: result.total,
    catalog: resolve(opts.catalog),
    localeFile: resolve(opts.localeFile),
    rows: result.rows,
  };
  await writeFile(join(outDir, "tidy.json"), JSON.stringify(tidyDoc, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "tidy.csv"), tidyRowsToCsv(result.rows), "utf8");
  await writeFile(
    join(outDir, "SUMMARY.md"),
    [
      "# Retrospective tidy summary",
      "",
      `- Locale: \`${opts.locale}\``,
      `- Judge: \`${judgeId}\``,
      `- Rows: ${result.total}`,
      `- Reopen: ${result.reopenCount}`,
      `- No back-translation (reopened for a human): ${result.skippedBt}`,
      `- Back-translations ignored as stale (made from an older wording): ${staleBt}`,
      `- Back-translations generated this run: ${generatedBt}`,
      `- Provider cost (reported): $${telemetry.costUsd}`,
      "",
      "Nothing is merged. Open review PRs only for the reopen rows you agree with.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        schema: "council.tidy-manifest.v1",
        command: "tidy",
        councilVersion: councilVersion(),
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        argv: opts.argv || null,
        locale: opts.locale,
        profile: run.profile,
        preset,
        stageModels,
        judge: judgeId,
        backtranslate: opts.generateBt ? run.providers.backtranslate : null,
        glossary: glossary ? { path: resolve(opts.glossary), version: glossaryVersion(glossary), hash: glossaryHash(glossary) } : null,
        tools,
        thresholds: { meaning: meaningThreshold },
        cost: { usd: telemetry.costUsd, complete: telemetry.costComplete, byStage: telemetry.byStage },
        cache: ctx.cache.stats(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const reopen = result.rows.filter((r) => r.reopen).map((r) => ({ key: r.key, why_bucket: r.why_bucket }));
  return envelope("tidy", {
    status: reopen.length ? "reopen" : "clean",
    exitCode: reopen.length ? EXIT.ATTENTION : EXIT.CLEAN,
    locale: opts.locale,
    profile: run.profile,
    preset,
    judge: judgeId,
    outDir,
    artifacts: {
      tidyJson: join(outDir, "tidy.json"),
      tidyCsv: join(outDir, "tidy.csv"),
      summary: join(outDir, "SUMMARY.md"),
      manifest: join(outDir, "manifest.json"),
    },
    counts: { rows: result.total, reopen: reopen.length, btMissing: result.skippedBt, btStale: staleBt, btGenerated: generatedBt },
    reopen,
    costUsd: telemetry.costUsd,
  });
}
