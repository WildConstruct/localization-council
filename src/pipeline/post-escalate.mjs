/**
 * Optional post-escalate stages: faceoff → consensus cull → blind audit.
 *
 * They run after the core council has decided which keys escalate, and
 * shrink the human sheet. Every stage is provider-agnostic, and nothing is
 * accepted into output unless it passes the same checks as the core
 * council (meaning threshold, glossary, protected tokens, ICU).
 *
 *   faceoff        extra candidates from other providers; each is
 *                  back-translated and judged; the top candidate wins when
 *                  it leads the next acceptable one by ≥ margin
 *   consensus cull near-ties where ≥ N candidates produced identical text
 *   blind audit    remaining near-ties: options shuffled into X/Y/Z with a
 *                  recorded seed, origins sealed in reveal.json, each judge
 *                  picks blind; ≥ N judges agreeing on a label wins
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAdapter, supportedStages } from "../providers/resolve.mjs";
import { normalizeCandidateText } from "../providers/contract.mjs";
import { translateStage } from "./translate.mjs";
import { backtranslateStage } from "./backtranslate.mjs";
import { judgeStage } from "./judge.mjs";
import { runStage } from "./stage.mjs";
import { candidateReasons } from "./escalate.mjs";

export const DEFAULT_THRESHOLDS = Object.freeze({
  meaning: 0.75,
  faceoffMargin: 0.05,
  consensusMin: 2,
  auditConsensusMin: 2,
});

const EPS = 1e-9;
const LABELS = ["X", "Y", "Z", "W", "V", "U", "T", "S", "R", "Q"];

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function rankCandidates(a, b) {
  return (
    b.meaning - a.meaning ||
    (b.fluency ?? 0) - (a.fluency ?? 0) ||
    a.provider.localeCompare(b.provider)
  );
}

/**
 * Faceoff: gather extra candidates for escalated keys and pick clear winners.
 *
 * @param {object} o
 * @param {string[]} o.keys - escalated keys
 * @param {Record<string,string>} o.sourceMap
 * @param {string} o.locale
 * @param {object|null} o.glossary
 * @param {object[]} o.coreCandidates / o.coreBacktranslations / o.coreScores - core artifacts
 * @param {string} o.coreTranslateProvider
 * @param {string[]} o.providers - faceoff translate providers
 * @param {{ backtranslate: object, judge: object }} o.adapters - core BT + judge adapters
 * @param {object} o.thresholds
 * @param {object} o.ctx
 * @param {object} [o.adapterOpts]
 */
export async function faceoffStage(o) {
  const { keys, sourceMap, locale, glossary, ctx, thresholds } = o;
  const wanted = new Set(keys);
  const bySource = new Map(); // key → candidate entries

  const coreBt = new Map(o.coreBacktranslations.map((b) => [b.key, b]));
  const coreScore = new Map(o.coreScores.map((s) => [s.key, s]));
  for (const c of o.coreCandidates) {
    if (!wanted.has(c.key)) continue;
    bySource.set(c.key, [entry(o.coreTranslateProvider, c, coreBt.get(c.key), coreScore.get(c.key), glossary, thresholds)]);
  }

  const extra = [...new Set(o.providers)].filter(
    (p) => p !== o.coreTranslateProvider && supportedStages(p).includes("translate"),
  );
  for (const provider of extra) {
    const adapter = createAdapter(provider, o.adapterOpts);
    const cands = await translateStage({ sourceMap, keys, locale, glossary, adapter, ctx });
    const bts = await backtranslateStage({ candidates: cands, locale, adapter: o.adapters.backtranslate, ctx });
    const scores = await judgeStage({ sourceMap, candidates: cands, backtranslations: bts, locale, glossary, adapter: o.adapters.judge, ctx });
    const btBy = new Map(bts.map((b) => [b.key, b]));
    const scoreBy = new Map(scores.map((s) => [s.key, s]));
    for (const c of cands) {
      bySource.get(c.key)?.push(entry(provider, c, btBy.get(c.key), scoreBy.get(c.key), glossary, thresholds));
    }
  }

  const rows = keys.map((key) => {
    const candidates = bySource.get(key) || [];
    return { key, source: sourceMap[key], ...faceoffDecision(candidates, thresholds.faceoffMargin), candidates };
  });

  return {
    providers: [o.coreTranslateProvider, ...extra],
    thresholds: { meaning: thresholds.meaning, margin: thresholds.faceoffMargin },
    rows,
    won: rows.filter((r) => r.status === "won").length,
    nearTie: rows.filter((r) => r.status === "near_tie").length,
    noValid: rows.filter((r) => r.status === "no_valid_candidate").length,
  };
}

/**
 * Faceoff rule. Only candidates that pass every council check compete.
 * The top one wins when it leads the next acceptable candidate by ≥ margin
 * (a sole acceptable candidate wins outright). Identical texts still count
 * as separate candidates here, so agreement becomes a near-tie that the
 * consensus cull can settle.
 * @returns {{ status: "won"|"near_tie"|"no_valid_candidate", winner: {provider,text}|null, margin: number|null }}
 */
export function faceoffDecision(candidates, faceoffMargin = DEFAULT_THRESHOLDS.faceoffMargin) {
  const eligible = candidates.filter((c) => c.eligible).sort(rankCandidates);
  if (!eligible.length) return { status: "no_valid_candidate", winner: null, margin: null };
  const [top, runner] = eligible;
  const margin = Math.round((runner ? top.meaning - runner.meaning : top.meaning) * 1e6) / 1e6;
  if (margin + EPS >= faceoffMargin) {
    return { status: "won", winner: { provider: top.provider, text: top.text }, margin };
  }
  return { status: "near_tie", winner: null, margin };
}

function entry(provider, cand, bt, score, glossary, thresholds) {
  const reasons = cand
    ? candidateReasons({ candidate: cand, score, glossary, meaningThreshold: thresholds.meaning })
    : ["missing_candidate"];
  return {
    provider,
    text: cand?.candidate ?? "",
    backtranslation: bt?.backtranslation ?? null,
    meaning: score?.meaning ?? 0,
    fluency: score?.fluency ?? 0,
    glossaryOk: score?.glossaryOk ?? false,
    icuOk: cand?.icuOk !== false,
    protectedTokensOk: cand?.protectedTokensOk !== false,
    eligible: reasons.length === 0,
    reasons,
  };
}

/**
 * Consensus cull: a near-tie is accepted when ≥ consensusMin candidates
 * produced identical (normalized) text AND that text passes every check.
 */
export function consensusCullStage(faceoffRows, { consensusMin = DEFAULT_THRESHOLDS.consensusMin } = {}) {
  const rows = [];
  for (const r of faceoffRows) {
    if (r.status !== "near_tie") continue;
    const groups = new Map();
    for (const c of r.candidates) {
      const norm = normalizeCandidateText(c.text);
      if (!groups.has(norm)) groups.set(norm, []);
      groups.get(norm).push(c);
    }
    const qualifying = [...groups.values()]
      .filter((g) => g.length >= consensusMin && g.every((c) => c.eligible))
      .sort((a, b) => b.length - a.length || b[0].meaning - a[0].meaning);
    // Two agreeing groups of the same size (e.g. 2 vs 2) is a split, not a consensus.
    const tieAtTop = qualifying.length > 1 && qualifying[0].length === qualifying[1].length;
    if (qualifying.length && !tieAtTop) {
      const g = qualifying[0];
      rows.push({
        key: r.key,
        status: "accepted",
        text: g[0].text,
        agreeing: g.map((c) => c.provider),
        checks: { meaning: g[0].meaning, glossaryOk: g[0].glossaryOk, icuOk: g[0].icuOk, protectedTokensOk: g[0].protectedTokensOk },
      });
    } else {
      rows.push({ key: r.key, status: "divergent", text: null, agreeing: [], checks: null });
    }
  }
  return {
    consensusMin,
    rows,
    accepted: rows.filter((r) => r.status === "accepted").length,
    divergent: rows.filter((r) => r.status === "divergent").length,
  };
}

/** Small seeded PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a hash. */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministically shuffle distinct texts into labeled options for one key. */
export function labelOptions(texts, seed, key) {
  const rng = mulberry32((seed ^ fnv1a(key)) >>> 0);
  const arr = texts.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const options = {};
  arr.slice(0, LABELS.length).forEach((t, i) => {
    options[LABELS[i]] = t;
  });
  return options;
}

function safeName(id) {
  return id.replace(/[^\w.-]+/g, "_");
}

/**
 * Blind comparative audit over near-ties the cull could not settle.
 * Writes <outDir>/blind-audit/{blind-items.json, reveal.json, results/, summary.json, BLIND-AUDIT.md}.
 */
export async function blindAuditStage({
  faceoffRows,
  keys,
  sourceMap,
  locale,
  glossary,
  judges,
  seed,
  auditConsensusMin = DEFAULT_THRESHOLDS.auditConsensusMin,
  outDir,
  ctx,
  adapterOpts,
}) {
  const dir = join(outDir, "blind-audit");
  await mkdir(join(dir, "results"), { recursive: true });
  const wanted = new Set(keys);

  const items = [];
  const reveal = {};
  const skipped = [];
  for (const r of faceoffRows) {
    if (!wanted.has(r.key)) continue;
    const byText = new Map();
    for (const c of r.candidates.filter((x) => x.eligible)) {
      const norm = normalizeCandidateText(c.text);
      if (!byText.has(norm)) byText.set(norm, { text: c.text, providers: [] });
      byText.get(norm).providers.push(c.provider);
    }
    if (byText.size < 2) {
      // Every acceptable candidate says the same thing: that's agreement, which the
      // consensus cull settles. Nothing to vote on here, so the row stays with a person.
      skipped.push(r.key);
      continue;
    }
    const options = labelOptions([...byText.keys()], seed, r.key);
    items.push({ key: r.key, source: sourceMap[r.key], options: Object.fromEntries(Object.entries(options).map(([l, n]) => [l, byText.get(n).text])) });
    reveal[r.key] = Object.fromEntries(Object.entries(options).map(([l, n]) => [l, byText.get(n).providers]));
  }

  // Judges receive blind-items.json only; reveal.json is written first and read after all verdicts.
  await writeJson(join(dir, "blind-items.json"), { locale, items });
  await writeJson(join(dir, "reveal.json"), { seed, items: reveal });

  const votes = new Map(items.map((it) => [it.key, []]));
  for (const judgeId of [...new Set(judges)]) {
    const adapter = createAdapter(judgeId, adapterOpts);
    const verdicts = items.length
      ? await runStage({ stage: "compare", adapter, locale, glossary, items, ctx })
      : [];
    await writeJson(join(dir, "results", `${safeName(judgeId)}.json`), { judge: judgeId, verdicts });
    for (const v of verdicts) votes.get(v.key)?.push({ judge: judgeId, pick: v.pick, abstainReasons: v.abstainReasons });
  }

  const rows = items.map((it) => {
    const tally = {};
    for (const v of votes.get(it.key)) if (v.pick) tally[v.pick] = (tally[v.pick] || 0) + 1;
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const [top, second] = ranked;
    const consensus = top && top[1] >= auditConsensusMin && (!second || second[1] < top[1]) ? top[0] : null;
    return {
      key: it.key,
      status: consensus ? "consensus" : "unresolved",
      label: consensus,
      text: consensus ? it.options[consensus] : null,
      providers: consensus ? reveal[it.key][consensus] : [],
      votes: votes.get(it.key),
      tally,
    };
  });

  for (const key of skipped) {
    rows.push({ key, status: "skipped_single_option", label: null, text: null, providers: [], votes: [], tally: {} });
  }
  const summary = {
    seed,
    judges: [...new Set(judges)],
    auditConsensusMin,
    consensus: rows.filter((r) => r.status === "consensus").length,
    unresolved: rows.filter((r) => r.status === "unresolved").length,
    skipped: skipped.length,
    rows,
  };
  await writeJson(join(dir, "summary.json"), summary);
  await writeFile(join(dir, "BLIND-AUDIT.md"), renderBlindAudit(summary, items), "utf8");
  return summary;
}

function renderBlindAudit(summary, items) {
  const src = new Map(items.map((i) => [i.key, i.source]));
  const lines = [
    "# Blind comparative audit",
    "",
    `- Seed: ${summary.seed} (rerun with --seed ${summary.seed} to reproduce the shuffle)`,
    `- Judges: ${summary.judges.map((j) => `\`${j}\``).join(", ")}`,
    `- Consensus rule: ≥ ${summary.auditConsensusMin} judges pick the same label`,
    `- Resolved: ${summary.consensus}; unresolved: ${summary.unresolved}; skipped (only one distinct option, use --consensus-cull): ${summary.skipped}`,
    "",
    "| Key | Source | Status | Label | Accepted text | Votes |",
    "|-----|--------|--------|-------|---------------|-------|",
  ];
  for (const r of summary.rows) {
    const votes = r.votes.map((v) => `${v.judge}:${v.pick ?? "abstain"}`).join(", ");
    lines.push(`| \`${r.key}\` | ${src.get(r.key)} | ${r.status} | ${r.label ?? "—"} | ${r.text ?? "—"} | ${votes} |`);
  }
  lines.push("", "Origins stay sealed in reveal.json until verdicts are in. Unresolved rows go to a human.", "");
  return lines.join("\n");
}
