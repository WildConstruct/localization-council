/**
 * The provider contract.
 *
 * Every adapter (mock, cli:*, openrouter:*, api:jev) is an object:
 *
 *   {
 *     id: "cli:claude",
 *     family: "anthropic",              // vendor family, used by the diversity check
 *     describe(stage) → { provider, model, family, promptVersion },
 *     batchSize(stage) → number,        // preferred items per call (pipeline caches per batch)
 *     translate(batch, ctx)     → Promise<object[]>
 *     backtranslate(batch, ctx) → Promise<object[]>
 *     judge(batch, ctx)         → Promise<object[]>
 *     compare(batch, ctx)       → Promise<object[]>   // blind comparative pick
 *   }
 *
 * Batches:
 *   translate:     { locale, glossary, items: [{ key, source }] }
 *   backtranslate: { locale, items: [{ key, candidate }] }          // never the source
 *   judge:         { locale, glossary, items: [{ key, source, candidate, backtranslation }] }
 *   compare:       { locale, glossary, items: [{ key, source, options: { X: text, … } }] }
 *
 * Adapters return raw per-item rows keyed by `key`; `normalizeStageResults`
 * turns them into the shapes in schemas/stage-results.v1.json and fails loudly
 * on a missing key or a malformed row. A stage an adapter cannot do throws
 * UnsupportedStageError.
 */

import { validateDef } from "../json-schema.mjs";

export const STAGES = Object.freeze(["translate", "backtranslate", "judge", "compare"]);

export class UnsupportedStageError extends Error {
  constructor(provider, stage, hint = "") {
    super(`${provider} does not support the ${stage} stage${hint ? ` — ${hint}` : ""}`);
    this.name = "UnsupportedStageError";
    this.code = "unsupported_stage";
    this.provider = provider;
    this.stage = stage;
  }
}

export class MissingVerdictError extends Error {
  constructor(provider, stage, key, detail = "") {
    super(`${provider} returned no ${stage} verdict for key "${key}"${detail ? `: ${detail}` : ""}`);
    this.name = "MissingVerdictError";
    this.code = "missing_verdict";
    this.provider = provider;
    this.stage = stage;
    this.key = key;
  }
}

/** Build an adapter method that always throws UnsupportedStageError. */
export function unsupported(provider, stage, hint) {
  return async () => {
    throw new UnsupportedStageError(provider, stage, hint);
  };
}

/**
 * Normalize and validate adapter output for one batch.
 * @param {string} stage
 * @param {object} batch - the batch that was sent
 * @param {object[]} rows - adapter output
 * @param {{ provider: string, model: string|null }} desc
 */
export function normalizeStageResults(stage, batch, rows, desc) {
  if (!Array.isArray(rows)) {
    throw new Error(`${desc.provider} ${stage} returned ${typeof rows}, expected an array`);
  }
  const byKey = new Map();
  for (const r of rows) {
    if (r && typeof r.key === "string") byKey.set(r.key, r);
  }
  const out = [];
  for (const item of batch.items) {
    const r = byKey.get(item.key);
    if (!r) throw new MissingVerdictError(desc.provider, stage, item.key);
    const row = shapeRow(stage, batch, item, r, desc);
    const { ok, errors } = validateDef(row, "stage-results.v1.json", stage);
    if (!ok) {
      throw new MissingVerdictError(desc.provider, stage, item.key, errors.slice(0, 3).join("; "));
    }
    out.push(row);
  }
  return out;
}

function shapeRow(stage, batch, item, r, desc) {
  const base = {
    key: item.key,
    provider: r.provider || desc.provider,
    model: r.model ?? desc.model ?? null,
  };
  if (stage === "translate") {
    return {
      ...base,
      locale: batch.locale,
      source: item.source,
      candidate: typeof r.candidate === "string" ? r.candidate.trim() : r.candidate,
    };
  }
  if (stage === "backtranslate") {
    return {
      ...base,
      locale: batch.locale,
      candidate: item.candidate,
      backtranslation:
        typeof r.backtranslation === "string" ? r.backtranslation.trim() : r.backtranslation,
    };
  }
  if (stage === "judge") {
    const row = {
      ...base,
      meaning: r.meaning,
      fluency: r.fluency,
      glossaryOk: r.glossaryOk,
      glossaryNotes: Array.isArray(r.glossaryNotes) ? r.glossaryNotes : [],
      escalate: r.escalate,
      rationale: r.rationale,
    };
    for (const extra of ["registerOk", "uiRoleOk", "confidenceUnsure", "usage"]) {
      if (r[extra] !== undefined) row[extra] = r[extra];
    }
    return row;
  }
  if (stage === "compare") {
    const labels = Object.keys(item.options || {});
    let pick = r.pick;
    if (pick === "none") pick = null;
    if (pick != null && !labels.includes(pick)) {
      throw new MissingVerdictError(
        desc.provider,
        stage,
        item.key,
        `pick ${JSON.stringify(r.pick)} is not one of ${labels.join("/")}`,
      );
    }
    const row = { ...base, pick: pick ?? null, rationale: String(r.rationale ?? "") };
    if (Array.isArray(r.abstainReasons)) row.abstainReasons = r.abstainReasons;
    return row;
  }
  throw new Error(`Unknown stage "${stage}"`);
}

/** Split an array into chunks of `size`. */
export function chunk(arr, size) {
  const n = Math.max(1, Math.floor(size) || 1);
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Run a per-item function across a batch (CLI adapters call one process per
 * item). Returns rows in input order.
 */
export async function perItem(items, fn) {
  const rows = [];
  for (const item of items) rows.push(await fn(item));
  return rows;
}

/** Normalize candidate text for identity checks (NFC, trim, collapse whitespace incl. NBSP). */
export function normalizeCandidateText(s) {
  if (s == null) return "";
  return String(s).normalize("NFC").trim().replace(/\s+/g, " ");
}
