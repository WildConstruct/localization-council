/**
 * Retrospective tidy / re-audit helpers (optional Jev gate).
 *
 * Re-audit shipped translations when a better gate/model appears — not a
 * full retranslate. See docs/retrospective-tidy.md.
 */

import {
  buildJevJudgeState,
  JEV_CONFIDENCE_FLOOR,
  JEV_DEFAULT_MODEL,
  JEV_NOUL_TRUE,
} from "./providers/jev-openrouter.mjs";

export const TIDY_WHY_BUCKETS = Object.freeze([
  "fine",
  "meaning",
  "glossary",
  "register",
  "ui_role",
  "icu",
  "other",
]);

export const TIDY_CSV_HEADERS = Object.freeze([
  "key",
  "locale",
  "en",
  "candidate",
  "backtranslation",
  "reopen",
  "why_bucket",
  "priority",
  "confidence_min",
  "model",
  "note",
  "cost",
]);

/** Missing-BT sentinel — never invent back-translations. */
export const TIDY_BT_MISSING = "(bt_missing)";

/**
 * Typed questions for retrospective tidy (one batched Decisions call).
 * Core: reopen + why_bucket; optional priority score.
 */
export function buildTidyQuestions({ includePriority = true } = {}) {
  const questions = {
    reopen: {
      type: "noul",
      instructions:
        "Should this shipped localization be reopened for human review or retranslate? Most rows that already shipped are fine — only reopen when meaning, glossary, register, UI role, or ICU looks wrong under a better gate.",
      criteria: {
        true: "Clear issue (meaning drift via BT, glossary violation, wrong register/UI role, ICU break) or confidence too low to leave closed.",
        false: "Shipped candidate remains acceptable; leave closed / no reopen.",
      },
    },
    why_bucket: {
      type: "choice",
      instructions:
        "If reopening, which primary bucket best describes the issue? If leaving closed, choose fine.",
      criteria: {
        fine: "No meaningful issue — leave closed.",
        meaning: "Meaning drift vs English source (often visible in blind BT).",
        glossary: "Glossary / practitioner-term violation.",
        register: "Register / product voice mismatch.",
        ui_role: "Wrong UI role or morphosyntax (e.g. noun vs imperative).",
        icu: "ICU / placeholder / MessageFormat structure problem.",
        other: "Other localization issue not covered above.",
      },
    },
  };
  if (includePriority) {
    questions.priority = {
      type: "score",
      instructions:
        "How urgently should a human reopen this row if it needs attention? Low when fine or cosmetic; high when meaning/glossary/ICU breaks ship quality.",
      criteria: [
        "Leave closed or cosmetic only",
        "Should review soon",
        "High priority reopen",
      ],
    };
  }
  return questions;
}

/**
 * Lean tidy state — reuses translator-judge lean builder.
 * When BT is missing, still emit a clear placeholder (do not invent BT).
 */
export function buildTidyState(row = {}) {
  const bt =
    row.backtranslation != null && String(row.backtranslation).trim() !== ""
      ? row.backtranslation
      : TIDY_BT_MISSING;
  return buildJevJudgeState({
    source: row.en ?? row.source ?? "",
    candidate: row.candidate ?? "",
    backtranslation: bt,
    locale: row.locale,
    key: row.key,
    glossary: row.glossary,
    icuOk: row.icuOk,
    icuMissing: row.icuMissing,
    icuExtras: row.icuExtras,
    ui_role: row.ui_role,
    register: row.register,
  });
}

function readNoul(answers, id) {
  const n = Number(answers?.[id]?.noul);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

function readConfidence(answers, id) {
  const c = Number(answers?.[id]?.confidence);
  if (!Number.isFinite(c) || c < 0 || c > 1) return null;
  return c;
}

function readChoice(answers, id) {
  const raw = answers?.[id]?.choice ?? answers?.[id]?.selected ?? null;
  if (typeof raw === "string" && raw) return raw;
  // Some APIs nest under .value
  const v = answers?.[id]?.value;
  if (typeof v === "string" && v) return v;
  return null;
}

function readScore(answers, id) {
  const s = Number(answers?.[id]?.score);
  if (!Number.isFinite(s)) return null;
  return s;
}

/**
 * Min confidence across watched tidy answers (when present).
 */
export function tidyMinConfidence(answers) {
  const ids = ["reopen", "why_bucket", "priority"];
  let min = null;
  for (const id of ids) {
    const c = readConfidence(answers, id);
    if (c == null) continue;
    min = min == null ? c : Math.min(min, c);
  }
  return min;
}

/**
 * Map Jev tidy answers → reopen decision.
 * confidence < JEV_CONFIDENCE_FLOOR → human/reopen (noul 0.5 ≠ medium confidence).
 */
export function mapTidyAnswers(answers, { key, model, usage, note } = {}) {
  if (!answers || typeof answers !== "object") {
    throw new Error("tidy: missing answers object");
  }

  const reopenNoul = readNoul(answers, "reopen");
  if (reopenNoul == null) {
    throw new Error(
      `tidy: invalid reopen.noul: ${JSON.stringify(answers.reopen)}`,
    );
  }

  let why = readChoice(answers, "why_bucket");
  if (why && !TIDY_WHY_BUCKETS.includes(why)) {
    why = "other";
  }
  if (!why) why = reopenNoul >= JEV_NOUL_TRUE ? "other" : "fine";

  const priority = readScore(answers, "priority");
  const confidenceMin = tidyMinConfidence(answers);
  const confidenceUnsure =
    confidenceMin != null && confidenceMin < JEV_CONFIDENCE_FLOOR;

  // Route in code on answer + confidence (noul 0.5 ≠ medium confidence).
  // reopen when: reopen noul ≥ 0.5 OR confidence unsure OR why_bucket ≠ fine.
  const reopen =
    reopenNoul >= JEV_NOUL_TRUE ||
    confidenceUnsure ||
    why !== "fine";

  const out = {
    key: key ?? null,
    reopen,
    reopen_noul: reopenNoul,
    why_bucket: why,
    priority: priority,
    confidence_min: confidenceMin,
    confidenceUnsure,
    model: model || process.env.JEV_MODEL || JEV_DEFAULT_MODEL,
    note: note || null,
  };
  if (usage && typeof usage === "object") {
    out.usage = {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cost: usage.cost,
    };
    out.cost = Number(usage.cost) || 0;
  } else {
    out.cost = 0;
  }
  return out;
}

/**
 * Build one tidy sheet row (JSON object) for CSV/JSON export.
 */
export function buildTidyRow({
  key,
  locale,
  en,
  candidate,
  backtranslation,
  decision,
  note,
} = {}) {
  const bt =
    backtranslation != null && String(backtranslation).trim() !== ""
      ? backtranslation
      : TIDY_BT_MISSING;
  const d = decision || {};
  return {
    key: key ?? "",
    locale: locale ?? "",
    en: en ?? "",
    candidate: candidate ?? "",
    backtranslation: bt,
    reopen: Boolean(d.reopen),
    why_bucket: d.why_bucket ?? "",
    priority: d.priority ?? "",
    confidence_min:
      d.confidence_min != null && Number.isFinite(d.confidence_min)
        ? d.confidence_min
        : "",
    model: d.model || process.env.JEV_MODEL || JEV_DEFAULT_MODEL,
    note: note || d.note || "",
    cost: Number.isFinite(d.cost) ? d.cost : 0,
  };
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialize tidy rows to CSV (header + body). */
export function tidyRowsToCsv(rows) {
  const lines = [TIDY_CSV_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(
      TIDY_CSV_HEADERS.map((h) => csvEscape(row[h])).join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Intersect EN ∩ locale keys; optional keysFile / limit filter.
 * @returns {{ key: string, en: string, candidate: string }[]}
 */
export function selectTidyKeys(enMap, localeMap, { keys, limit } = {}) {
  let ids = Object.keys(enMap).filter(
    (k) =>
      Object.prototype.hasOwnProperty.call(localeMap, k) &&
      localeMap[k] != null &&
      String(localeMap[k]) !== "",
  );
  if (Array.isArray(keys) && keys.length) {
    const allow = new Set(keys.map(String));
    ids = ids.filter((k) => allow.has(k));
  }
  ids.sort();
  if (Number.isFinite(limit) && limit >= 0) {
    ids = ids.slice(0, limit);
  }
  return ids.map((key) => ({
    key,
    en: enMap[key],
    candidate: localeMap[key],
  }));
}

/**
 * Load key→BT map from prior council artifacts.
 * Accepts: { key: bt }, { key: { backtranslation } }, or [{ key, backtranslation }].
 */
export function loadBtMap(raw) {
  const map = {};
  if (!raw) return map;
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!row || row.key == null) continue;
      const bt = row.backtranslation ?? row.bt ?? row.text;
      if (bt != null && String(bt).trim() !== "") map[String(row.key)] = String(bt);
    }
    return map;
  }
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (v == null) continue;
      if (typeof v === "string" && v.trim()) map[k] = v;
      else if (typeof v === "object") {
        const bt = v.backtranslation ?? v.bt ?? v.text;
        if (bt != null && String(bt).trim() !== "") map[k] = String(bt);
      }
    }
  }
  return map;
}

/**
 * Candidate text each back-translation was made from, when the file records
 * it (a prior run's backtranslations.json does). Used to drop stale entries
 * whose candidate no longer matches the shipped string.
 * @returns {Record<string, string>}
 */
export function loadBtCandidates(raw) {
  const map = {};
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (row && row.key != null && typeof row.candidate === "string") map[String(row.key)] = row.candidate;
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === "object" && typeof v.candidate === "string") map[k] = v.candidate;
    }
  }
  return map;
}
