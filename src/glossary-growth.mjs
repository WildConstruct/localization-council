/**
 * Glossary growth: the product's glossary keeps up with what ships.
 *
 *   council glossary harvest   reads shipped string pairs (English catalog + locale catalog, plus a
 *                              run's accepted.json if given), asks a provider which product or
 *                              domain terms each pair uses and how it renders them (the `terms`
 *                              stage), checks every answer against the strings, and proposes
 *                              glossary entries for recurring terms the glossary doesn't cover.
 *   council glossary apply     folds a person's decisions on those proposals into the glossary:
 *                              approved terms become entries (with rejected renderings), declined
 *                              terms are recorded so they aren't proposed again.
 *
 * Nothing is enforced until a person approves it. Harvest never edits the glossary. Apply writes
 * glossary.next.json under --out unless a person passes --write. Agents never decide proposals.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { loadCatalog } from "./catalog.mjs";
import { loadGlossary, validateGlossary, sourceHasTerm, sameTerm, keysUsingTerm } from "./glossary.mjs";
import { loadModelsConfig, applyModelSelection, councilVersion, expandStageSpec } from "./config.mjs";
import { resolveRunProviders, createAdapter, supportedStages, isKnownProvider } from "./providers/resolve.mjs";
import { normalizeCandidateText } from "./providers/contract.mjs";
import { runStage } from "./pipeline/stage.mjs";
import { createRunContext, glossaryVersion, glossaryHash } from "./run-context.mjs";
import { toolVersions } from "./doctor.mjs";
import { envelope, EXIT, UsageError } from "./summary.mjs";
import { numberOption } from "./options.mjs";
import { parseKeysFile } from "./tidy.mjs";

export const PROPOSALS_SCHEMA_ID = "council.glossary-proposals.v1";
export const DEFAULT_MIN_KEYS = 2;

/** Fields of a proposal that come from harvest and that a person may edit before deciding. */
const SUGGESTED = ["source", "practitionerTerm", "productMeaning", "reject"];

const fold = (s) => String(s ?? "").normalize("NFC").toLowerCase();

/** Most frequent value (ties: shorter, then alphabetical). */
function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

/**
 * Keep only term answers the strings back up: the English term must occur in the source and the
 * rendering must occur in the shipped translation. Everything else is set aside as unverified.
 * @param {object[]} rows - normalized `terms` stage rows
 */
export function verifyTerms(rows) {
  const observations = [];
  const unverified = [];
  for (const row of rows) {
    for (const t of row.terms) {
      let reason = null;
      if (!t.source || !t.target) reason = "empty_term";
      else if (!sourceHasTerm(row.source, t.source)) reason = "term_not_in_source";
      else if (!fold(row.candidate).includes(fold(t.target))) reason = "rendering_not_in_translation";
      if (reason) unverified.push({ key: row.key, source: t.source, target: t.target, reason });
      else observations.push({ key: row.key, source: t.source, target: t.target, base: t.base || t.target, productMeaning: t.productMeaning });
    }
  }
  return { observations, unverified };
}

/**
 * Group verified observations by English term, then decide each term's status against the glossary.
 * @param {{ observations: object[], glossary: object|null, enMap: Record<string,string>, minKeys?: number }} o
 * @returns {object[]} one row per term: { id, source, status, keys, affectedKeys, renderings, productMeaning, consistent }
 */
export function groupTerms({ observations, glossary = null, enMap = {}, minKeys = DEFAULT_MIN_KEYS }) {
  const groups = [];
  const bySpelling = new Map(); // exact lowercase spelling → group, so repeats skip the scan
  // Shorter spellings first, so "layer" becomes the group "layers" joins.
  const sorted = [...observations].sort((a, b) => a.source.length - b.source.length || a.source.localeCompare(b.source));
  for (const o of sorted) {
    const spelling = o.source.toLowerCase();
    let g = bySpelling.get(spelling) ?? groups.find((x) => x.spellings.some((s) => sameTerm(s, o.source)));
    if (!g) {
      g = { spellings: [], obs: [] };
      groups.push(g);
    }
    bySpelling.set(spelling, g);
    if (!g.spellings.includes(o.source)) g.spellings.push(o.source);
    g.obs.push(o);
  }

  return groups
    .map((g) => {
      const source = mostCommon(g.obs.map((o) => o.source)) || g.spellings[0];
      const keys = [...new Set(g.obs.map((o) => o.key))].sort();
      const byBase = new Map();
      for (const o of g.obs) {
        const k = fold(o.base);
        if (!byBase.has(k)) byBase.set(k, { bases: [], forms: new Set(), keys: new Set() });
        const r = byBase.get(k);
        r.bases.push(o.base);
        r.forms.add(o.target);
        r.keys.add(o.key);
      }
      const renderings = [...byBase.values()]
        .map((r) => ({ term: mostCommon(r.bases), forms: [...r.forms].sort(), keys: [...r.keys].sort() }))
        .sort((a, b) => b.keys.length - a.keys.length || a.term.localeCompare(b.term));
      // A term is covered when it is an entry's source or one of its related terms.
      const entry = glossaryEntryFor(glossary, g.spellings);
      const declined = glossary?.declined?.find((d) => g.spellings.some((s) => sameTerm(s, d.source)));
      let status = "proposed";
      if (entry) status = "in_glossary";
      else if (declined) status = "declined";
      else if (keys.length < minKeys) status = "below_min_keys";
      return {
        id: source.toLowerCase(),
        source,
        status,
        keys,
        affectedKeys: keysUsingTerm(enMap, g.spellings),
        renderings,
        consistent: renderings.length === 1,
        productMeaning: mostCommon(g.obs.map((o) => o.productMeaning)),
        ...(entry ? { glossaryEntry: entry.source } : {}),
      };
    })
    .sort((a, b) => b.keys.length - a.keys.length || a.source.localeCompare(b.source));
}

/** The glossary entry a term belongs to: same source term, or one of the entry's related terms. */
export function glossaryEntryFor(glossary, spellings) {
  return glossary?.entries?.find((e) =>
    [e.source, ...(e.relatedTerms ?? [])].some((t) => spellings.some((s) => sameTerm(s, t))),
  );
}

/** A fresh proposal for a term: what a person edits and decides first, then the evidence. */
function toProposal(t) {
  const suggested = { source: t.source, practitionerTerm: t.renderings[0]?.term ?? "", productMeaning: t.productMeaning, reject: [] };
  return {
    id: t.id,
    ...suggested,
    decision: null,
    reject: [],
    why: "",
    suggested,
    consistent: t.consistent,
    renderings: t.renderings,
    keys: t.keys,
    affectedKeys: t.affectedKeys,
  };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Whether a person touched a proposal: decided it, gave a reason, or changed a suggested field. */
function personTouched(p) {
  if (p.decision != null && p.decision !== "") return true;
  if (typeof p.why === "string" && p.why !== "") return true;
  return SUGGESTED.some((f) => p[f] !== undefined && !same(p[f], p.suggested?.[f] ?? (f === "reject" ? [] : undefined)));
}

/**
 * Carry a person's work over from an earlier proposals file: their decision, reason, and any field
 * they changed from what harvest suggested. Evidence is always refreshed. A proposal a person
 * touched is never dropped: when this harvest doesn't propose it again (a narrower --keys-file, a
 * catalog change), it is kept as is and marked `stale`, until apply puts it in the glossary.
 * @returns {{ proposals: object[], kept: number, stale: object[] }}
 */
export function mergeDecisions(proposals, previous) {
  const prev = (previous?.proposals ?? []).filter((o) => o && typeof o.id === "string");
  const matched = new Set();
  let kept = 0;
  const merged = proposals.map((p) => {
    const old = prev.find((o) => !matched.has(o) && (o.id === p.id || sameTerm(o.id, p.id)));
    if (!old) return p;
    matched.add(old);
    if (!personTouched(old)) return p;
    kept += 1;
    const next = { ...p };
    for (const f of SUGGESTED) {
      if (old[f] !== undefined && !same(old[f], old.suggested?.[f] ?? (f === "reject" ? [] : undefined))) next[f] = old[f];
    }
    if (old.decision != null && old.decision !== "") next.decision = old.decision;
    if (typeof old.why === "string" && old.why !== "") next.why = old.why;
    return next;
  });
  const stale = prev.filter((o) => !matched.has(o) && personTouched(o)).map((o) => ({ ...o, stale: true }));
  return { proposals: merged, kept: kept + stale.length, stale };
}

function renderProposalsMd({ locale, proposals, counts, proposalsPath, glossaryPath }) {
  const lines = [`# Glossary proposals: ${locale}`, ""];
  if (!proposals.length) {
    lines.push("Every recurring term in the shipped strings is already in the glossary (or was declined). Nothing to decide.", "");
  } else {
    lines.push(
      `${proposals.length} recurring term(s) appear in shipped strings without a glossary entry. Nothing is enforced until a person approves it.`,
      "",
    );
    for (const p of proposals) {
      lines.push(
        `## ${p.source} (${p.keys.length} key${p.keys.length === 1 ? "" : "s"}${p.consistent ? "" : ", renderings disagree"})`,
        "",
        `Suggested: **${p.practitionerTerm}**${p.productMeaning ? ` (${p.productMeaning})` : ""}${p.decision ? ` · decision so far: \`${p.decision}\`` : ""}`,
        "",
        "| Rendering | Forms | Keys |",
        "|-----------|-------|------|",
        ...p.renderings.map((r) => `| ${r.term} | ${r.forms.join(", ")} | ${r.keys.map((k) => `\`${k}\``).join(", ")} |`),
        "",
      );
    }
  }
  lines.push(
    "## How to decide",
    "",
    `Edit \`${proposalsPath}\`. For each proposal set \`"decision"\` to \`"approve"\` or \`"decline"\`:`,
    "",
    "- **approve**: fix `source`, `practitionerTerm` and `productMeaning` if needed, and list renderings to reject in",
    '  `"reject"` (a string, or `{ "term", "why" }`). Inflected forms of the approved term are not rejections.',
    '- **decline**: not a glossary term. Say why in `"why"`; harvest won\'t propose it again.',
    "",
    "Then fold the decisions into the glossary (a person runs this; `--write` updates the file in place):",
    "",
    "```bash",
    `council glossary apply --proposals ${proposalsPath}${glossaryPath ? ` --glossary ${glossaryPath}` : " --glossary <glossary.json>"}`,
    "```",
    "",
    `Terms seen: ${counts.terms} · already in the glossary: ${counts.inGlossary} · declined earlier: ${counts.declined} · ` +
      `seen in fewer than ${counts.minKeys} keys: ${counts.belowMinKeys} · answers not backed by the strings: ${counts.unverified}`,
    "",
  );
  return lines.join("\n");
}

/**
 * Read an earlier proposals file so a person's decisions carry over. A file that exists but doesn't
 * parse is a usage error: overwriting it would throw away their work.
 */
async function readPreviousProposals(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new UsageError(
      `${path} exists but isn't valid JSON (${err.message}). Fix it, or move it away, before harvesting into the same --out; ` +
        "it may hold a person's decisions.",
    );
  }
}

/**
 * `council glossary harvest`.
 * @param {object} opts - see `council help`
 */
export async function runGlossaryHarvest(opts) {
  const startedAt = new Date();
  for (const f of ["catalog", "localeFile", "locale"]) {
    if (!opts[f]) throw new UsageError(`glossary harvest requires --${f === "localeFile" ? "locale-file" : f}`);
  }
  const stageModels = Object.fromEntries(Object.entries(opts.stageModels || {}).filter(([, v]) => v != null));
  let preset = opts.preset || null;
  const models = applyModelSelection(loadModelsConfig({ modelsFile: opts.modelsFile }), { preset, stageModels });
  const run = resolveRunProviders({ mock: opts.mock, provider: opts.provider, profile: opts.profile, models });
  // The extractor defaults to the profile's judge (an analytic model), or its translator when the
  // judge can't extract terms (api:jev).
  let extractorId;
  if (opts.extractor) {
    extractorId = expandStageSpec(opts.extractor, "judge", models);
    if (!isKnownProvider(extractorId)) throw new UsageError(`Unknown extractor "${opts.extractor}"`);
    if (!supportedStages(extractorId).includes("terms")) throw new UsageError(`${extractorId} cannot extract terms`);
  } else {
    extractorId = supportedStages(run.providers.judge).includes("terms") ? run.providers.judge : run.providers.translate;
  }
  // A preset or model override only changes an OpenRouter extractor.
  if ((preset || Object.keys(stageModels).length) && !extractorId.startsWith("openrouter:")) {
    if (opts.presetSource !== "env" || Object.keys(stageModels).length) {
      throw new UsageError("--preset/--*-model only affect an OpenRouter extractor; use --profile=openrouter or --extractor openrouter");
    }
    preset = null;
  }
  const warnings = [];
  if (run.profile === "mock" && run.source === "default") {
    warnings.push({
      code: "mock_profile_default",
      message: "No profile given, so terms came from the offline mock extractor. Use --profile fleet or openrouter for real catalogs.",
    });
  }
  const minKeys = numberOption(opts.minKeys, "--min-keys", DEFAULT_MIN_KEYS, { min: 1, integer: true });
  const limit = numberOption(opts.limit, "--limit", null, { min: 0, integer: true });

  const enMap = await loadCatalog(opts.catalog);
  const localeMap = { ...(await loadCatalog(opts.localeFile)) };
  let acceptedCount = 0;
  if (opts.accepted) {
    // Strings a run accepted into output that a person hasn't merged yet. They're newer than the catalog.
    for (const [k, v] of Object.entries(await loadCatalog(opts.accepted))) {
      localeMap[k] = v;
      acceptedCount += 1;
    }
  }
  const glossary = opts.glossary ? await loadGlossary(opts.glossary) : null;
  if (glossary && glossary.locale !== opts.locale && process.env.GLOSSARY_LOCALE_OVERRIDE !== "1") {
    throw new UsageError(
      `Glossary locale "${glossary.locale}" does not match --locale "${opts.locale}". Set GLOSSARY_LOCALE_OVERRIDE=1 to override.`,
    );
  }
  const allow = opts.keysFile ? new Set(parseKeysFile(await readFile(opts.keysFile, "utf8"))) : null;

  let skippedIdentical = 0;
  let pairs = Object.keys(enMap)
    .filter((k) => (!allow || allow.has(k)) && typeof localeMap[k] === "string" && localeMap[k].trim() && String(enMap[k]).trim())
    .sort()
    .filter((k) => {
      // A string identical to its source may be untranslated: it is no evidence of a rendering.
      if (normalizeCandidateText(localeMap[k]) !== normalizeCandidateText(enMap[k])) return true;
      skippedIdentical += 1;
      return false;
    })
    .map((k) => ({ key: k, source: String(enMap[k]), candidate: String(localeMap[k]) }));
  if (Number.isFinite(limit)) pairs = pairs.slice(0, limit);

  const outDir = resolve(opts.out || `./scores/${opts.locale}-glossary`);
  await mkdir(outDir, { recursive: true });
  const tools = await toolVersions(new Set([extractorId]), models);
  const providerSalt = Object.fromEntries(
    Object.values(tools.cli).map((t) => [`cli:${t.name}`, `${t.name}@${t.version ?? "unknown"}`]),
  );
  const ctx = await createRunContext({ outDir, cacheDir: opts.cacheDir, cache: opts.cache !== false, providerSalt });
  const adapter = createAdapter(extractorId, { models, fetchImpl: opts.fetchImpl });

  let rows;
  try {
    rows = await runStage({ stage: "terms", adapter, locale: opts.locale, items: pairs, ctx });
  } finally {
    await ctx.settle();
  }
  const { observations, unverified } = verifyTerms(rows);
  const terms = groupTerms({ observations, glossary, enMap, minKeys });

  const proposalsPath = join(outDir, "glossary-proposals.json");
  const previous = await readPreviousProposals(proposalsPath);
  const fresh = terms.filter((t) => t.status === "proposed").map(toProposal);
  const { proposals: merged, kept, stale } = mergeDecisions(fresh, previous);
  // A stale proposal whose term has since reached the glossary (or its declined list) is done.
  const open = stale.filter((p) => !glossaryEntryFor(glossary, [p.id, p.source]) && !glossary?.declined?.some((d) => sameTerm(d.source, p.id)));
  // Terms with disagreeing renderings first: those are the ones a glossary settles.
  const proposals = [
    ...[...merged].sort(
      (a, b) => Number(a.consistent) - Number(b.consistent) || b.keys.length - a.keys.length || a.source.localeCompare(b.source),
    ),
    ...open,
  ];

  const telemetry = ctx.telemetry.summary();
  const cacheStats = ctx.cache.stats();
  const counts = {
    pairs: pairs.length,
    fromAccepted: acceptedCount,
    skippedIdentical,
    terms: terms.length,
    proposals: proposals.length,
    keptDecisions: kept,
    stale: open.length,
    inGlossary: terms.filter((t) => t.status === "in_glossary").length,
    declined: terms.filter((t) => t.status === "declined").length,
    belowMinKeys: terms.filter((t) => t.status === "below_min_keys").length,
    unverified: unverified.length,
    minKeys,
    cacheHits: Object.values(cacheStats.hits).reduce((a, b) => a + b, 0),
  };
  const glossaryRef = glossary
    ? { path: resolve(opts.glossary), version: glossaryVersion(glossary), hash: glossaryHash(glossary), entries: glossary.entries.length }
    : null;

  await writeFile(
    join(outDir, "terms.json"),
    JSON.stringify({ locale: opts.locale, extractor: extractorId, glossary: glossaryRef, minKeys, terms, unverified }, null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    proposalsPath,
    JSON.stringify(
      {
        schema: PROPOSALS_SCHEMA_ID,
        locale: opts.locale,
        glossary: glossaryRef,
        note:
          'A person decides each proposal: set "decision" to "approve" or "decline", then run `council glossary apply`. ' +
          "Agents never fill in decisions. Nothing here is enforced until it is in the glossary.",
        proposals,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(
    join(outDir, "PROPOSALS.md"),
    renderProposalsMd({ locale: opts.locale, proposals, counts, proposalsPath, glossaryPath: opts.glossary }),
    "utf8",
  );
  await writeFile(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        schema: "council.glossary-manifest.v1",
        command: "glossary harvest",
        councilVersion: councilVersion(),
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        argv: opts.argv || null,
        locale: opts.locale,
        catalog: resolve(opts.catalog),
        localeFile: resolve(opts.localeFile),
        accepted: opts.accepted ? resolve(opts.accepted) : null,
        profile: run.profile,
        preset,
        stageModels,
        extractor: extractorId,
        model: adapter.describe("terms").model,
        glossary: glossaryRef,
        tools,
        thresholds: { minKeys },
        counts,
        cost: { usd: telemetry.costUsd, complete: telemetry.costComplete, byStage: telemetry.byStage },
        cache: cacheStats,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return envelope("glossary", {
    status: proposals.length ? "proposals" : "clean",
    exitCode: proposals.length ? EXIT.ATTENTION : EXIT.CLEAN,
    action: "harvest",
    locale: opts.locale,
    profile: run.profile,
    extractor: extractorId,
    outDir,
    artifacts: {
      proposals: proposalsPath,
      report: join(outDir, "PROPOSALS.md"),
      terms: join(outDir, "terms.json"),
      manifest: join(outDir, "manifest.json"),
    },
    counts,
    proposals: proposals.map(summaryRow),
    costUsd: telemetry.costUsd,
    warnings,
  });
}

function summaryRow(p) {
  return { source: p.source, practitionerTerm: p.practitionerTerm, keys: p.keys.length, consistent: p.consistent, decision: p.decision ?? null };
}

/**
 * Fold decided proposals into a glossary. Pure: returns the next glossary and what happened.
 * @param {object} glossary - validated glossary (may have no entries)
 * @param {object} doc - glossary-proposals.json
 */
export function applyProposals(glossary, doc) {
  if (doc?.schema !== PROPOSALS_SCHEMA_ID || !Array.isArray(doc.proposals)) {
    throw new UsageError(`Not a proposals file (expected schema "${PROPOSALS_SCHEMA_ID}" from \`council glossary harvest\`)`);
  }
  if (doc.locale && glossary.locale !== doc.locale) {
    throw new UsageError(`Proposals are for "${doc.locale}" but the glossary is for "${glossary.locale}"`);
  }
  const next = { ...glossary, entries: [...glossary.entries] };
  const declined = [...(glossary.declined ?? [])];
  const result = { approved: [], declined: [], pending: [], skipped: [], affectedKeys: new Set() };

  for (const p of doc.proposals) {
    const label = String(p.source || p.id || "?");
    if (p.decision == null || p.decision === "") {
      result.pending.push(p);
      continue;
    }
    if (p.decision !== "approve" && p.decision !== "decline") {
      throw new UsageError(`Proposal "${label}": decision must be "approve", "decline" or null, not ${JSON.stringify(p.decision)}`);
    }
    const source = String(p.source ?? "").trim();
    if (!source) throw new UsageError(`Proposal "${label}": source must not be empty`);
    const existing = glossaryEntryFor(next, [source]);
    if (existing || declined.some((d) => sameTerm(d.source, source))) {
      result.skipped.push({ source, decision: p.decision, reason: existing ? `already in the glossary as "${existing.source}"` : "declined earlier" });
      continue;
    }
    if (p.decision === "decline") {
      const why = String(p.why ?? "").trim() || "Not a glossary term (declined in review).";
      declined.push({ source, why });
      result.declined.push(source);
      continue;
    }
    const practitionerTerm = String(p.practitionerTerm ?? "").trim();
    if (!practitionerTerm) throw new UsageError(`Proposal "${label}": approve needs a practitionerTerm`);
    const rejected = [];
    for (const r of Array.isArray(p.reject) ? p.reject : []) {
      const term = String(typeof r === "string" ? r : r?.term ?? "").trim();
      if (!term) throw new UsageError(`Proposal "${label}": every reject needs a term`);
      // Rejected terms are found anywhere inside a candidate, so one inside the approved term would
      // flag every string that uses the approved term.
      if (fold(practitionerTerm).includes(fold(term))) {
        throw new UsageError(
          `Proposal "${label}": rejecting "${term}" would also flag the approved "${practitionerTerm}", which contains it`,
        );
      }
      const why = String(typeof r === "string" ? "" : r?.why ?? "").trim() || `Use "${practitionerTerm}" (approved in glossary review).`;
      rejected.push({ term, why });
    }
    next.entries.push({
      source,
      locale: glossary.locale,
      productMeaning: String(p.productMeaning ?? "").trim(),
      relatedTerms: [],
      practitionerTerm,
      approved: true,
      rejected,
      origin: { via: "harvest", keys: Array.isArray(p.keys) ? p.keys.map(String) : [] },
    });
    result.approved.push(source);
    for (const k of Array.isArray(p.affectedKeys) ? p.affectedKeys : []) result.affectedKeys.add(String(k));
  }
  if (declined.length) next.declined = declined;
  validateGlossary(next);
  return { glossary: next, ...result, affectedKeys: [...result.affectedKeys].sort() };
}

/**
 * `council glossary apply`.
 * @param {{ proposals: string, glossary: string, out?: string, write?: boolean, argv?: string[] }} opts
 */
export async function runGlossaryApply(opts) {
  if (!opts.proposals) throw new UsageError("glossary apply requires --proposals");
  if (!opts.glossary) throw new UsageError("glossary apply requires --glossary (a new file is started if it doesn't exist)");
  let doc;
  try {
    doc = JSON.parse(await readFile(opts.proposals, "utf8"));
  } catch (err) {
    throw new UsageError(`Can't read --proposals ${opts.proposals}: ${err.message}`);
  }
  const glossaryPath = resolve(opts.glossary);
  const started = !existsSync(glossaryPath);
  if (started && !doc?.locale) {
    throw new UsageError(`${glossaryPath} doesn't exist and the proposals file names no locale to start a new glossary with`);
  }
  const raw = started ? null : await readFile(glossaryPath, "utf8");
  const glossary = started ? { schemaVersion: "0", locale: doc.locale, entries: [] } : await loadGlossary(glossaryPath);
  const r = applyProposals(glossary, doc);

  const outDir = resolve(opts.out || dirname(resolve(opts.proposals)));
  await mkdir(outDir, { recursive: true });
  const changed = r.approved.length + r.declined.length > 0;
  const nextPath = opts.write ? glossaryPath : join(outDir, "glossary.next.json");
  if (changed) {
    await mkdir(dirname(nextPath), { recursive: true });
    // Keep the file's indentation and one-line arrays, so the diff in the product repo is the new entries.
    await writeFile(nextPath, formatJson(r.glossary, raw?.match(/^([ \t]+)"/m)?.[1] ?? "  ") + "\n", "utf8");
  }
  let affectedPath = null;
  if (r.approved.length) {
    affectedPath = join(outDir, "affected-keys.json");
    await writeFile(affectedPath, JSON.stringify({ keys: r.affectedKeys }, null, 2) + "\n", "utf8");
  }

  const warnings = [];
  const skippedApprovals = r.skipped.filter((x) => x.decision === "approve");
  if (skippedApprovals.length) {
    warnings.push({
      code: "approval_skipped",
      message: `Not added: ${skippedApprovals.map((x) => `"${x.source}" (${x.reason})`).join(", ")}.`,
    });
  }
  if (changed && typeof glossary.version === "string" && glossary.version) {
    warnings.push({
      code: "glossary_version_unchanged",
      message: `The glossary's version is still "${glossary.version}". Bump it if you track versions; the cache doesn't need it.`,
    });
  }
  const pending = r.pending.length > 0;
  return envelope("glossary", {
    status: pending ? "proposals" : changed || r.skipped.length ? "applied" : "clean",
    exitCode: pending ? EXIT.ATTENTION : EXIT.CLEAN,
    action: "apply",
    locale: r.glossary.locale,
    profile: null,
    extractor: null,
    outDir,
    artifacts: {
      glossary: changed ? nextPath : null,
      affectedKeys: affectedPath,
    },
    counts: {
      approved: r.approved.length,
      declined: r.declined.length,
      pending: r.pending.length,
      skipped: r.skipped.length,
      entries: r.glossary.entries.length,
      affectedKeys: r.affectedKeys.length,
    },
    written: changed ? (opts.write ? "in_place" : "next_file") : "nothing",
    newGlossary: started && changed,
    skipped: r.skipped.map(({ source, reason }) => ({ source, reason })),
    proposals: r.pending.map(summaryRow),
    costUsd: null,
    warnings,
  });
}

/**
 * JSON with one-line arrays of short scalars (["comp", "sequence"]) and everything else expanded,
 * the way glossaries are usually written by hand.
 */
export function formatJson(value, indent = "  ", depth = 0) {
  const pad = indent.repeat(depth);
  const inner = indent.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    if (value.every((v) => v === null || typeof v !== "object")) {
      const one = `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
      if (pad.length + one.length <= 100) return one;
    }
    return `[\n${value.map((v) => inner + formatJson(v, indent, depth + 1)).join(",\n")}\n${pad}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (!keys.length) return "{}";
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${formatJson(value[k], indent, depth + 1)}`).join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
}
