import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { loadCatalog, diffCatalogFiles, computeMissingKeys } from "./catalog.mjs";
import { loadGlossary } from "./glossary.mjs";
import { loadModelsConfig, applyModelSelection, councilVersion } from "./config.mjs";
import { translateStage } from "./pipeline/translate.mjs";
import { backtranslateStage } from "./pipeline/backtranslate.mjs";
import { judgeStage } from "./pipeline/judge.mjs";
import { buildEscalation, renderReport } from "./pipeline/escalate.mjs";
import {
  faceoffStage,
  consensusCullStage,
  blindAuditStage,
  DEFAULT_THRESHOLDS,
  fnv1a,
} from "./pipeline/post-escalate.mjs";
import { parseProviderSpec, resolveAdapters, resolveRunProviders, isKnownProvider, supportedStages } from "./providers/resolve.mjs";
import { diversityWarnings } from "./providers/families.mjs";
import { createRunContext, glossaryVersion, glossaryHash } from "./run-context.mjs";
import { envelope, emptyRunFields, EXIT, UsageError } from "./summary.mjs";
import { numberOption } from "./options.mjs";
import { toolVersions } from "./doctor.mjs";

export { diffCatalogFiles as diffCatalogs, computeMissingKeys, loadCatalog };
export { loadGlossary, validateGlossary } from "./glossary.mjs";
export { extractIcuArgs, checkIcuStructure, ICU_PRESERVE_PROMPT, ICU_TYPE_KEYWORDS } from "./icu.mjs";
export { parseProviderSpec, resolveRunProviders };
export { createAdapter } from "./providers/resolve.mjs";
export { diversityWarnings, familyOf } from "./providers/families.mjs";
export { runGardenDryDiff, resolveGardenPath, gardenPathCandidates, pickExistingPath, activeLocaleSet } from "./garden.mjs";
export { runTidy } from "./tidy.mjs";
export { runDoctor } from "./doctor.mjs";
export { EXIT } from "./summary.mjs";

export const ARTIFACTS = Object.freeze({
  candidates: "candidates.json",
  backtranslations: "backtranslations.json",
  scores: "scores.json",
  escalate: "escalate.json",
  accepted: "accepted.json",
  report: "report.md",
  manifest: "manifest.json",
  log: "run.log",
});

async function writeJson(dir, name, value) {
  await writeFile(join(dir, name), JSON.stringify(value, null, 2) + "\n", "utf8");
}

function list(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v;
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Run the Localization Council pipeline and return the run summary
 * (the same object `council run --json` prints).
 *
 * @param {object} opts
 * @param {string} opts.catalog - source (EN) catalog path
 * @param {string} opts.locale - BCP 47 tag
 * @param {string} [opts.glossary] - glossary JSON path
 * @param {string} [opts.out] - output dir (default ./scores/<locale>)
 * @param {string} [opts.target] - target catalog; only missing/untranslated keys run
 * @param {string[]} [opts.keys] - explicit key filter
 * @param {string} [opts.profile] - fleet | openrouter | mock
 * @param {string} [opts.provider] - advanced: provider spec or stage map
 * @param {boolean} [opts.mock] - shorthand for profile mock
 * @param {number} [opts.meaningThreshold=0.75]
 * @param {boolean} [opts.faceoff] / opts.consensusCull / opts.blindAudit - post-escalate stages
 * @param {string[]|string} [opts.faceoffProviders] / opts.auditJudges
 * @param {number} [opts.faceoffMargin=0.05] / opts.consensusMin=2 / opts.auditConsensusMin=2
 * @param {number} [opts.seed] - blind-audit shuffle seed (default derived from locale + catalog name)
 * @param {boolean} [opts.cache=true] / opts.cacheDir
 * @param {string} [opts.modelsFile] - merged over config/models.json
 * @param {boolean} [opts.strictDiversity] - fail instead of warn on shared model families
 * @param {typeof fetch} [opts.fetchImpl] - injected fetch (tests)
 * @param {string[]} [opts.argv] - recorded in manifest.json
 */
export async function runCouncil(opts) {
  const startedAt = new Date();
  const { catalog, locale } = opts;
  if (!catalog) throw new UsageError("run requires --catalog");
  if (!locale) throw new UsageError("run requires --locale");

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
  const providers = run.providers;
  const thresholds = {
    meaning: numberOption(opts.meaningThreshold, "--meaning-threshold", DEFAULT_THRESHOLDS.meaning, { min: 0, max: 1 }),
    faceoffMargin: numberOption(opts.faceoffMargin, "--faceoff-margin", DEFAULT_THRESHOLDS.faceoffMargin, { min: 0, max: 1 }),
    consensusMin: numberOption(opts.consensusMin, "--consensus-min", DEFAULT_THRESHOLDS.consensusMin, { min: 2, integer: true }),
    auditConsensusMin: numberOption(opts.auditConsensusMin, "--audit-consensus-min", DEFAULT_THRESHOLDS.auditConsensusMin, {
      min: 1,
      integer: true,
    }),
  };
  const post = {
    faceoff: Boolean(opts.faceoff || opts.consensusCull || opts.blindAudit),
    consensusCull: Boolean(opts.consensusCull),
    blindAudit: Boolean(opts.blindAudit),
  };
  const faceoffProviders = (list(opts.faceoffProviders) || run.faceoff).map((p) =>
    p === "openrouter" ? `openrouter:${models.openrouter.stages.translate}` : p,
  );
  const auditJudges = (list(opts.auditJudges) || run.auditJudges).map((p) =>
    p === "openrouter" ? `openrouter:${models.openrouter.stages.judge}` : p,
  );
  const seed = numberOption(opts.seed, "--seed", null, { min: 0, max: 0xffffffff, integer: true }) ?? fnv1a(`${locale}:${basename(catalog)}`);
  // Check the post-escalate panels now, not after the core stages have spent money.
  if (post.faceoff) {
    for (const p of faceoffProviders) {
      if (!isKnownProvider(p)) throw new UsageError(`Unknown provider "${p}" in the faceoff panel (--faceoff-providers)`);
      if (!supportedStages(p).includes("translate")) {
        throw new UsageError(`${p} cannot translate, so it cannot be in the faceoff panel (--faceoff-providers)`);
      }
    }
  }
  if (post.blindAudit) {
    for (const j of auditJudges) {
      if (!isKnownProvider(j)) throw new UsageError(`Unknown provider "${j}" in the audit panel (--audit-judges)`);
    }
  }

  const warnings = diversityWarnings(providers);
  if (opts.strictDiversity && warnings.length) {
    throw new UsageError(`--strict-diversity: ${warnings.map((w) => w.message).join(" ")}`);
  }

  const sourceMap = await loadCatalog(catalog);
  const glossary = opts.glossary ? await loadGlossary(opts.glossary) : null;
  if (glossary && glossary.locale !== locale && process.env.GLOSSARY_LOCALE_OVERRIDE !== "1") {
    throw new UsageError(
      `Glossary locale "${glossary.locale}" does not match run locale "${locale}". Set GLOSSARY_LOCALE_OVERRIDE=1 to override.`,
    );
  }

  let keys = opts.keys ?? null;
  if (!keys && opts.target) {
    const delta = computeMissingKeys(sourceMap, await loadCatalog(opts.target));
    keys = [...delta.missing.map((m) => m.key), ...delta.untranslated.map((u) => u.key)];
  }
  keys = (keys ?? Object.keys(sourceMap)).filter((k) => sourceMap[k] != null);
  const emptySource = keys.filter((k) => String(sourceMap[k]).trim() === "");
  if (emptySource.length) {
    keys = keys.filter((k) => String(sourceMap[k]).trim() !== "");
    warnings.push({
      code: "empty_source_skipped",
      message: `${emptySource.length} key(s) have an empty English source and were skipped: ${emptySource.slice(0, 5).join(", ")}${emptySource.length > 5 ? ", …" : ""}.`,
    });
  }

  const outDir = resolve(opts.out || `./scores/${locale}`);
  const baseSummary = {
    ...emptyRunFields(),
    locale,
    profile: run.profile,
    preset,
    providers,
    models: null,
    warnings,
  };

  if (!keys.length) {
    return envelope("run", {
      status: "clean",
      exitCode: EXIT.CLEAN,
      ...baseSummary,
      outDir,
      counts: zeroCounts(),
      skipped: true,
      reason: "no_missing_or_untranslated_keys",
    });
  }

  await mkdir(outDir, { recursive: true });
  const usedProviders = new Set([
    ...Object.values(providers),
    ...(post.faceoff ? faceoffProviders : []),
    ...(post.blindAudit ? auditJudges : []),
  ]);
  const tools = await toolVersions(usedProviders, models);
  const providerSalt = Object.fromEntries(
    Object.values(tools.cli).map((t) => [`cli:${t.name}`, `${t.name}@${t.version ?? "unknown"}`]),
  );
  const ctx = await createRunContext({ outDir, cacheDir: opts.cacheDir, cache: opts.cache !== false, providerSalt, onLog: opts.onLog });
  const adapterOpts = { models, fetchImpl: opts.fetchImpl };
  const adapters = resolveAdapters(providers, adapterOpts);
  const modelsByStage = Object.fromEntries(
    ["translate", "backtranslate", "judge"].map((s) => [s, adapters[s].describe(s).model]),
  );

  try {
    const candidates = await translateStage({ sourceMap, keys, locale, glossary, adapter: adapters.translate, ctx });
    await writeJson(outDir, ARTIFACTS.candidates, candidates);

    const backtranslations = await backtranslateStage({ candidates, locale, adapter: adapters.backtranslate, ctx });
    await writeJson(outDir, ARTIFACTS.backtranslations, backtranslations);

    const scores = await judgeStage({
      sourceMap,
      candidates,
      backtranslations,
      locale,
      glossary,
      adapter: adapters.judge,
      ctx,
    });
    await writeJson(outDir, ARTIFACTS.scores, scores);

    const escalation = buildEscalation({ candidates, scores, glossary, meaningThreshold: thresholds.meaning });
    const btByKey = new Map(backtranslations.map((b) => [b.key, b.backtranslation]));
    for (const item of escalation.items) item.backtranslation = btByKey.get(item.key) ?? null;
    const initialEscalations = escalation.count;
    // Snapshot before post-escalate stages so an interrupted run still leaves a consistent sheet.
    await writeJson(outDir, ARTIFACTS.escalate, escalationDoc(escalation, []));

    const accepted = [...escalation.accepted];
    const resolved = [];
    let resolution = null;

    if (post.faceoff && escalation.items.length) {
      const escKeys = escalation.items.map((i) => i.key);
      const faceoff = await faceoffStage({
        keys: escKeys,
        sourceMap,
        locale,
        glossary,
        coreCandidates: candidates,
        coreBacktranslations: backtranslations,
        coreScores: scores,
        coreTranslateProvider: providers.translate,
        providers: faceoffProviders,
        adapters,
        thresholds,
        ctx,
        adapterOpts,
      });
      await writeJson(outDir, "faceoff.json", faceoff);
      for (const r of faceoff.rows) {
        if (r.status === "won") resolved.push({ key: r.key, text: r.winner.text, via: "faceoff", provider: r.winner.provider });
      }
      resolution = { initialEscalations, faceoff: { won: faceoff.won, nearTie: faceoff.nearTie, noValid: faceoff.noValid } };

      let divergent = faceoff.rows.filter((r) => r.status === "near_tie").map((r) => r.key);
      if (post.consensusCull) {
        const cull = consensusCullStage(faceoff.rows, { consensusMin: thresholds.consensusMin });
        await writeJson(outDir, "consensus-cull.json", cull);
        for (const r of cull.rows) {
          if (r.status === "accepted") resolved.push({ key: r.key, text: r.text, via: "consensus_cull", provider: r.agreeing.join("+") });
        }
        divergent = cull.rows.filter((r) => r.status === "divergent").map((r) => r.key);
        resolution.consensusCull = { accepted: cull.accepted, divergent: cull.divergent };
      }
      if (post.blindAudit && divergent.length) {
        const audit = await blindAuditStage({
          faceoffRows: faceoff.rows,
          keys: divergent,
          sourceMap,
          locale,
          glossary,
          judges: auditJudges,
          seed,
          auditConsensusMin: thresholds.auditConsensusMin,
          outDir,
          ctx,
          adapterOpts,
        });
        for (const r of audit.rows) {
          if (r.status === "consensus") resolved.push({ key: r.key, text: r.text, via: "blind_audit", provider: r.providers.join("+") });
        }
        resolution.blindAudit = { consensus: audit.consensus, unresolved: audit.unresolved, skipped: audit.skipped };
      } else if (post.blindAudit) {
        resolution.blindAudit = { consensus: 0, unresolved: 0, skipped: 0 };
      }

      const trail = new Map(faceoff.rows.map((r) => [r.key, [`faceoff:${r.status}`]]));
      const resolvedKeys = new Set(resolved.map((r) => r.key));
      escalation.items = escalation.items.filter((i) => !resolvedKeys.has(i.key));
      for (const i of escalation.items) i.postEscalate = trail.get(i.key) || [];
      escalation.count = escalation.items.length;
      accepted.push(...resolved.map(({ key, text, via }) => ({ key, text, via })));
      resolution.resolved = resolved;
    }
    escalation.acceptedCount = accepted.length;

    await writeJson(outDir, ARTIFACTS.escalate, escalationDoc(escalation, resolved));
    await writeJson(outDir, ARTIFACTS.accepted, {
      locale,
      note: "Accepted into output by the council. A person merges these into the product catalog; the council never merges.",
      strings: Object.fromEntries(accepted.map((a) => [a.key, a.text])),
      via: Object.fromEntries(accepted.map((a) => [a.key, a.via])),
    });

    await ctx.settle();
    const telemetry = ctx.telemetry.summary();
    await writeFile(
      join(outDir, ARTIFACTS.report),
      renderReport({
        locale,
        profile: run.profile,
        providers,
        candidates,
        scores,
        backtranslations,
        escalation,
        resolution,
        warnings,
        costUsd: telemetry.calls ? telemetry.costUsd : null,
      }),
      "utf8",
    );

    const cacheStats = ctx.cache.stats();
    const cacheHits = Object.values(cacheStats.hits).reduce((a, b) => a + b, 0);
    const counts = {
      keys: candidates.length,
      accepted: accepted.length,
      escalated: escalation.count,
      initialEscalations,
      resolvedByFaceoff: resolved.filter((r) => r.via === "faceoff").length,
      resolvedByConsensusCull: resolved.filter((r) => r.via === "consensus_cull").length,
      resolvedByBlindAudit: resolved.filter((r) => r.via === "blind_audit").length,
      cacheHits,
    };

    for (const t of Object.values(tools.cli)) {
      if (t.versionOk === false) {
        warnings.push({
          code: "cli_below_min_version",
          message: `${t.name} ${t.version} is older than the minimum ${t.minVersion} in config/models.json.`,
        });
      }
    }

    const manifest = {
      schema: "council.manifest.v1",
      councilVersion: councilVersion(),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      argv: opts.argv || null,
      locale,
      catalog: resolve(catalog),
      target: opts.target ? resolve(opts.target) : null,
      glossary: glossary ? { path: resolve(opts.glossary), version: glossaryVersion(glossary), hash: glossaryHash(glossary) } : null,
      profile: run.profile,
      profileSource: run.source,
      preset,
      stageModels,
      providers,
      models: Object.fromEntries(
        ["translate", "backtranslate", "judge", "compare"].map((s) => [
          s,
          {
            requested: s === "compare" ? null : modelsByStage[s],
            resolved: telemetry.byStage[s]?.resolvedModels || [],
            providers: telemetry.byStage[s]?.providers || [],
          },
        ]),
      ),
      thresholds,
      seed,
      postEscalate: {
        ...post,
        faceoffProviders: post.faceoff ? faceoffProviders : [],
        auditJudges: post.blindAudit ? auditJudges : [],
      },
      tools,
      cost: {
        usd: telemetry.costUsd,
        complete: telemetry.costComplete,
        note: telemetry.costComplete ? null : "Some providers (e.g. grok/codex CLIs) do not report cost.",
        byStage: Object.fromEntries(Object.entries(telemetry.byStage).map(([s, v]) => [s, { calls: v.calls, usd: Math.round(v.costUsd * 1e6) / 1e6 }])),
      },
      cache: cacheStats,
      counts,
      warnings,
    };
    await writeJson(outDir, ARTIFACTS.manifest, manifest);

    const exitCode = escalation.count > 0 ? EXIT.ATTENTION : EXIT.CLEAN;
    return envelope("run", {
      status: escalation.count > 0 ? "escalations" : "clean",
      exitCode,
      ...baseSummary,
      models: modelsByStage,
      outDir,
      artifacts: Object.fromEntries(Object.entries(ARTIFACTS).map(([k, v]) => [k, join(outDir, v)])),
      counts,
      escalations: escalation.items.map((i) => ({ key: i.key, reasons: i.reasons })),
      costUsd: telemetry.costUsd,
      warnings,
    });
  } finally {
    await ctx.settle();
  }
}

function zeroCounts() {
  return {
    keys: 0,
    accepted: 0,
    escalated: 0,
    initialEscalations: 0,
    resolvedByFaceoff: 0,
    resolvedByConsensusCull: 0,
    resolvedByBlindAudit: 0,
    cacheHits: 0,
  };
}

function escalationDoc(escalation, resolved) {
  return {
    threshold: escalation.threshold,
    count: escalation.count,
    items: escalation.items,
    resolved,
    note: "Hand these rows to a person. Nothing here is merged; accepted.json holds what the council accepted into output.",
  };
}
