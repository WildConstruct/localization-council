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
import { loadGlossary, validateGlossary, sourceHasTerm, sameTerm, keysUsingTerm, termIndex } from "./glossary.mjs";
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
      const declined = g.spellings.some((s) => isDeclined(glossary, s));
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

const entryIndexes = new WeakMap();

/** The glossary entry a term belongs to: same source term, or one of the entry's related terms. */
export function glossaryEntryFor(glossary, spellings) {
  const entries = glossary?.entries;
  if (!entries?.length) return undefined;
  let cached = entryIndexes.get(entries);
  if (!cached || cached.length !== entries.length) {
    cached = { length: entries.length, index: termIndex(entries, (e) => [e.source, ...(e.relatedTerms ?? [])]) };
    entryIndexes.set(entries, cached);
  }
  for (const s of spellings) {
    const hit = cached.index.find(s);
    if (hit) return hit;
  }
  return undefined;
}

/** Whether a glossary's declined list has the term. */
function isDeclined(glossary, term) {
  return Boolean(glossary?.declined?.length && termIndex(glossary.declined, (d) => [d.source]).find(term));
}

/**
 * Approved entries other apps' glossaries have for a term (same source term or a related term).
 * @param {string[]} spellings
 * @param {{ name: string, glossary: object }[]} references
 */
export function referencesFor(spellings, references) {
  const out = [];
  for (const ref of references ?? []) {
    const e = glossaryEntryFor(ref.glossary, spellings);
    if (e?.approved) {
      out.push({ app: ref.name, source: e.source, practitionerTerm: e.practitionerTerm, productMeaning: e.productMeaning, rejected: e.rejected });
    }
  }
  return out;
}

/** Whether this app's renderings match what other apps approved: agrees | differs | not_shipped. */
function crossAppAgreement(renderings, refs) {
  if (!renderings.length) return "not_shipped";
  const approved = new Set(refs.map((r) => fold(r.practitionerTerm)));
  return renderings.every((r) => approved.has(fold(r.term))) ? "agrees" : "differs";
}

/**
 * A fresh proposal for a term: what a person edits and decides first, then the evidence. When
 * another app already approved the term, its practitioner term and rejected terms are the
 * suggestion. Its meaning isn't: the same term can mean something else in this app, so the person
 * writes that (this app's extracted meaning, if any, is the starting point).
 */
function toProposal(t, refs = [], kind = "harvest") {
  const ref = refs[0];
  const practitionerTerm = ref?.practitionerTerm ?? t.renderings[0]?.term ?? "";
  const reject = (ref?.rejected ?? [])
    .filter((r) => r.term && !fold(practitionerTerm).includes(fold(r.term)))
    .map((r) => ({ term: r.term, why: `${r.why} (rejected in ${ref.app})` }));
  const suggested = { source: t.source, practitionerTerm, productMeaning: t.productMeaning, reject };
  return {
    id: t.id,
    kind,
    ...suggested,
    decision: null,
    why: "",
    suggested,
    ...(refs.length ? { reference: refs, crossApp: crossAppAgreement(t.renderings, refs) } : {}),
    consistent: t.consistent,
    renderings: t.renderings,
    keys: t.keys,
    affectedKeys: t.affectedKeys,
  };
}

/**
 * Terms another app approved that this app's English uses but that have no entry, decline or
 * harvest proposal here. They become `carry_over` proposals even when nothing has shipped yet, or
 * when this app uses them in fewer than --min-keys keys: the other app's decision is the evidence.
 * @param {{ references: object[], glossary: object|null, terms: object[], enMap: Record<string,string> }} o
 */
export function carryOverTerms({ references, glossary, terms, enMap }) {
  const out = [];
  const chosen = termIndex([], (o) => [o.source]);
  const declined = termIndex(glossary?.declined ?? [], (d) => [d.source]);
  const seenTerms = termIndex(terms, (t) => [t.source]);
  for (const ref of references ?? []) {
    for (const e of ref.glossary?.entries ?? []) {
      if (!e.approved || chosen.find(e.source)) continue;
      if (glossaryEntryFor(glossary, [e.source]) || declined.find(e.source)) continue;
      const seen = seenTerms.find(e.source);
      if (seen && seen.status !== "below_min_keys") continue;
      const affectedKeys = seen?.affectedKeys ?? keysUsingTerm(enMap, [e.source]);
      if (!affectedKeys.length) continue;
      chosen.add({ source: e.source });
      out.push(
        seen
          ? { ...seen, status: "carry_over" }
          : {
              id: e.source.toLowerCase(),
              source: e.source,
              status: "carry_over",
              keys: [],
              affectedKeys,
              renderings: [],
              consistent: true,
              productMeaning: "",
            },
      );
    }
  }
  return out;
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
    const carry = proposals.filter((p) => p.kind === "carry_over").length;
    lines.push(
      `${proposals.length} term(s) have no glossary entry yet` +
        (carry ? `, ${carry} of them approved in another app` : "") +
        ". Nothing is enforced until a person approves it.",
      "",
    );
    for (const p of proposals) {
      const seen = p.keys.length ? `${p.keys.length} key${p.keys.length === 1 ? "" : "s"}` : "not in shipped strings yet";
      const notes = [seen, p.consistent ? null : "renderings disagree", p.kind === "carry_over" ? "approved in another app" : null, p.stale ? "stale" : null];
      lines.push(`## ${p.source} (${notes.filter(Boolean).join(", ")})`, "");
      lines.push(
        `Suggested: **${p.practitionerTerm}**${p.productMeaning ? ` (${p.productMeaning})` : ""}${p.decision ? ` · decision so far: \`${p.decision}\`` : ""}`,
        "",
      );
      for (const r of p.reference ?? []) {
        const rejects = r.rejected?.length ? `; rejects ${r.rejected.map((x) => `"${x.term}"`).join(", ")}` : "";
        lines.push(`- In \`${r.app}\`: **${r.practitionerTerm}**${r.productMeaning ? `, meaning "${r.productMeaning}"` : ""}${rejects}`);
      }
      if (p.reference?.length) {
        lines.push(
          p.crossApp === "differs"
            ? "- This app's shipped strings use a different rendering. Check whether the term means the same thing here."
            : "- Write what the term means in this app: the other app's meaning may not fit.",
          "",
        );
      }
      if (p.renderings.length) {
        lines.push(
          "| Rendering | Forms | Keys |",
          "|-----------|-------|------|",
          ...p.renderings.map((r) => `| ${r.term} | ${r.forms.join(", ")} | ${r.keys.map((k) => `\`${k}\``).join(", ")} |`),
          "",
        );
      } else if (p.affectedKeys.length) {
        lines.push(`Used in the English of: ${p.affectedKeys.slice(0, 8).map((k) => `\`${k}\``).join(", ")}${p.affectedKeys.length > 8 ? ", …" : ""}`, "");
      }
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
 * Pick the term extractor: --extractor, else the profile's judge (an analytic model), else its
 * translator when the judge can't extract terms (api:jev).
 */
export function resolveExtractor(opts) {
  const stageModels = Object.fromEntries(Object.entries(opts.stageModels || {}).filter(([, v]) => v != null));
  let preset = opts.preset || null;
  const models = applyModelSelection(loadModelsConfig({ modelsFile: opts.modelsFile }), { preset, stageModels });
  const run = resolveRunProviders({ mock: opts.mock, provider: opts.provider, profile: opts.profile, models });
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
  return { models, run, extractorId, preset, stageModels, warnings };
}

/** Shipped pairs worth extracting from: translated (not identical to the English) and non-empty. */
function shippedPairs(enMap, localeMap, { allow = null, limit = null } = {}) {
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
  return { pairs, skippedIdentical };
}

/**
 * Harvest one catalog: extract and verify terms, group them, add carry-over terms from other apps'
 * glossaries, merge a person's earlier decisions, and write terms.json, glossary-proposals.json
 * and PROPOSALS.md under outDir. Used by `council glossary harvest` and `council garden --mode glossary`.
 * @returns {Promise<object>} { pairs, terms, carryOver, proposals, unverified, counts, glossaryRef, artifacts }
 */
export async function harvestCatalog({
  enMap,
  localeMap,
  locale,
  glossary = null,
  glossaryPath = null,
  references = [],
  adapter,
  extractorId,
  ctx,
  outDir,
  minKeys = DEFAULT_MIN_KEYS,
  allow = null,
  limit = null,
  acceptedCount = 0,
}) {
  const proposalsPath = join(outDir, "glossary-proposals.json");
  const previous = await readPreviousProposals(proposalsPath); // before any provider call: a broken file fails fast
  const { pairs, skippedIdentical } = shippedPairs(enMap, localeMap, { allow, limit });
  const rows = await runStage({ stage: "terms", adapter, locale, items: pairs, ctx });
  const { observations, unverified } = verifyTerms(rows);
  const terms = groupTerms({ observations, glossary, enMap, minKeys });
  const carryOver = carryOverTerms({ references, glossary, terms, enMap });

  const fresh = [
    ...terms.filter((t) => t.status === "proposed").map((t) => toProposal(t, referencesFor([t.source], references))),
    ...carryOver.map((t) => toProposal(t, referencesFor([t.source], references), "carry_over")),
  ];
  const { proposals: merged, kept, stale } = mergeDecisions(fresh, previous);
  // A stale proposal whose term has since reached the glossary (or its declined list) is done.
  const open = stale.filter((p) => !glossaryEntryFor(glossary, [p.id, p.source]) && !isDeclined(glossary, p.id));
  // Terms with disagreeing renderings first (those are the ones a glossary settles), then terms
  // other apps approved, then anything a person touched that this harvest didn't see again.
  const order = (p) => (p.kind === "carry_over" ? 2 : p.consistent ? 1 : 0);
  const proposals = [
    ...[...merged].sort(
      (a, b) =>
        order(a) - order(b) ||
        b.keys.length - a.keys.length ||
        b.affectedKeys.length - a.affectedKeys.length ||
        a.source.localeCompare(b.source),
    ),
    ...open,
  ];

  const counts = {
    pairs: pairs.length,
    fromAccepted: acceptedCount,
    skippedIdentical,
    terms: terms.length,
    proposals: proposals.length,
    carryOver: proposals.filter((p) => p.kind === "carry_over").length,
    keptDecisions: kept,
    stale: open.length,
    inGlossary: terms.filter((t) => t.status === "in_glossary").length,
    declined: terms.filter((t) => t.status === "declined").length,
    belowMinKeys: terms.filter((t) => t.status === "below_min_keys").length,
    unverified: unverified.length,
    minKeys,
  };
  const glossaryRef = glossary
    ? { path: glossaryPath ? resolve(glossaryPath) : null, version: glossaryVersion(glossary), hash: glossaryHash(glossary), entries: glossary.entries.length }
    : null;
  const referenceRefs = references.map((r) => ({ name: r.name, path: r.path ?? null, entries: r.glossary.entries.length }));

  await writeFile(
    join(outDir, "terms.json"),
    JSON.stringify(
      { locale, extractor: extractorId, glossary: glossaryRef, references: referenceRefs, minKeys, terms, carryOver, unverified },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(
    proposalsPath,
    JSON.stringify(
      {
        schema: PROPOSALS_SCHEMA_ID,
        locale,
        glossary: glossaryRef,
        references: referenceRefs,
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
  const report = join(outDir, "PROPOSALS.md");
  await writeFile(report, renderProposalsMd({ locale, proposals, counts, proposalsPath, glossaryPath }), "utf8");
  return {
    pairs,
    terms,
    carryOver,
    proposals,
    unverified,
    counts,
    glossaryRef,
    referenceRefs,
    artifacts: { proposals: proposalsPath, report, terms: join(outDir, "terms.json") },
  };
}

/**
 * Load reference glossaries (other apps' approved terms): comma-separated paths, each optionally
 * named, e.g. "entropy=../entropy/locales/glossary.de.json". The name defaults to the path.
 */
async function loadReferences(spec, locale) {
  const parts = String(spec ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const refs = [];
  for (const part of parts) {
    const named = part.match(/^([\w.@-]+(?:\/[\w.@-]+)?)=(.+)$/);
    const [name, path] = named ? [named[1], named[2]] : [part, part];
    const glossary = await loadGlossary(path);
    if (glossary.locale !== locale && process.env.GLOSSARY_LOCALE_OVERRIDE !== "1") {
      throw new UsageError(`Reference glossary ${path} is for "${glossary.locale}", not "${locale}"`);
    }
    refs.push({ name, path: resolve(path), glossary });
  }
  return refs;
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
  const { models, run, extractorId, preset, stageModels, warnings } = resolveExtractor(opts);
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
  const references = await loadReferences(opts.references, opts.locale);
  const allow = opts.keysFile ? new Set(parseKeysFile(await readFile(opts.keysFile, "utf8"))) : null;

  const outDir = resolve(opts.out || `./scores/${opts.locale}-glossary`);
  await mkdir(outDir, { recursive: true });
  const tools = await toolVersions(new Set([extractorId]), models);
  const providerSalt = Object.fromEntries(
    Object.values(tools.cli).map((t) => [`cli:${t.name}`, `${t.name}@${t.version ?? "unknown"}`]),
  );
  const ctx = await createRunContext({ outDir, cacheDir: opts.cacheDir, cache: opts.cache !== false, providerSalt });
  const adapter = createAdapter(extractorId, { models, fetchImpl: opts.fetchImpl });

  let h;
  try {
    h = await harvestCatalog({
      enMap,
      localeMap,
      locale: opts.locale,
      glossary,
      glossaryPath: opts.glossary,
      references,
      adapter,
      extractorId,
      ctx,
      outDir,
      minKeys,
      allow,
      limit,
      acceptedCount,
    });
  } finally {
    await ctx.settle();
  }

  const telemetry = ctx.telemetry.summary();
  const cacheStats = ctx.cache.stats();
  const counts = { ...h.counts, cacheHits: Object.values(cacheStats.hits).reduce((a, b) => a + b, 0) };
  const manifestPath = join(outDir, "manifest.json");
  await writeFile(
    manifestPath,
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
        glossary: h.glossaryRef,
        references: h.referenceRefs,
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
    status: h.proposals.length ? "proposals" : "clean",
    exitCode: h.proposals.length ? EXIT.ATTENTION : EXIT.CLEAN,
    action: "harvest",
    locale: opts.locale,
    profile: run.profile,
    extractor: extractorId,
    outDir,
    artifacts: { ...h.artifacts, manifest: manifestPath },
    counts,
    proposals: h.proposals.map(summaryRow),
    costUsd: telemetry.costUsd,
    warnings,
  });
}

function summaryRow(p) {
  return {
    source: p.source,
    practitionerTerm: p.practitionerTerm,
    keys: Array.isArray(p.keys) ? p.keys.length : 0,
    consistent: p.consistent !== false,
    decision: p.decision ?? null,
    kind: p.kind === "carry_over" ? "carry_over" : "harvest",
    from: p.reference?.[0]?.app ?? null,
  };
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
      origin: {
        via: p.kind === "carry_over" ? "reference" : "harvest",
        ...(p.reference?.[0]?.app ? { from: String(p.reference[0].app) } : {}),
        keys: Array.isArray(p.keys) ? p.keys.map(String) : [],
      },
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
