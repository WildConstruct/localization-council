/**
 * Shared judge / compare output schemas and fail-closed parsing.
 * Used by cli:codex / cli:claude / cli:grok and openrouter.
 *
 * Schemas live in schemas/ (judge-verdict.v1.json, compare-verdict.v1.json);
 * this module re-exports them for CLIs that take a schema flag.
 */

import { glossaryPromptBlock } from "../glossary.mjs";
import { loadSchema } from "../json-schema.mjs";
import { MissingVerdictError } from "./contract.mjs";

export const JUDGE_OUTPUT_SCHEMA = loadSchema("judge-verdict.v1.json");
export const COMPARE_OUTPUT_SCHEMA = loadSchema("compare-verdict.v1.json");

/** Strip $schema/$id/title/description so CLIs get a plain schema object. */
export function bareSchema(schema) {
  const { $schema, $id, title, description, ...rest } = schema;
  return rest;
}

/** Compare schema narrowed to the labels of one item (plus "none"). */
export function compareSchemaFor(labels) {
  const s = bareSchema(COMPARE_OUTPUT_SCHEMA);
  return {
    ...s,
    properties: { ...s.properties, pick: { type: "string", enum: [...labels, "none"] } },
  };
}

/**
 * Build glossary lines for a judge prompt. Empty string when no glossary.
 */
export function judgeGlossaryBlock(glossary) {
  if (!glossary) return "";
  return glossaryPromptBlock(glossary);
}

/**
 * Fail-closed validation of a judge JSON object.
 *
 * `escalate` in the result is the judge's own flag OR a glossary failure.
 * The meaning threshold is applied by the pipeline (buildEscalation), so the
 * --meaning-threshold flag works the same for every judge.
 *
 * @param {object} parsed
 * @param {{ provider: string, key: string, glossary?: object|null }} ctx
 */
export function validateJudgeParsed(parsed, { provider, key, glossary }) {
  if (!parsed || typeof parsed !== "object") {
    throw new MissingVerdictError(provider, "judge", key, "judge returned a non-object");
  }

  if (!("glossaryOk" in parsed) || typeof parsed.glossaryOk !== "boolean") {
    throw new MissingVerdictError(
      provider,
      "judge",
      key,
      glossary
        ? "missing glossaryOk while a glossary was supplied (fail closed)"
        : "missing required boolean glossaryOk",
    );
  }

  // Scores must be JSON numbers: true, "1" or [1] are malformed, not perfect scores.
  const meaning = typeof parsed.meaning === "number" ? parsed.meaning : NaN;
  const fluency = typeof parsed.fluency === "number" ? parsed.fluency : NaN;
  if (!Number.isFinite(meaning) || meaning < 0 || meaning > 1) {
    throw new MissingVerdictError(
      provider,
      "judge",
      key,
      `invalid meaning (need finite 0–1): ${JSON.stringify(parsed.meaning)}`,
    );
  }
  if (!Number.isFinite(fluency) || fluency < 0 || fluency > 1) {
    throw new MissingVerdictError(
      provider,
      "judge",
      key,
      `invalid fluency (need finite 0–1): ${JSON.stringify(parsed.fluency)}`,
    );
  }
  if (typeof parsed.escalate !== "boolean") {
    throw new MissingVerdictError(provider, "judge", key, "missing required boolean escalate");
  }
  if (typeof parsed.rationale !== "string") {
    throw new MissingVerdictError(provider, "judge", key, "missing required string rationale");
  }

  return {
    provider,
    key,
    meaning,
    fluency,
    glossaryOk: parsed.glossaryOk,
    glossaryNotes: [],
    escalate: parsed.escalate || parsed.glossaryOk === false,
    rationale: parsed.rationale,
  };
}

/** Parse CLI stdout that should be a JSON object (or contain one). */
function parseJsonObject(out, { provider, stage, key, allowRegexSalvage }) {
  const text = String(out ?? "").trim();
  if (!text) throw new MissingVerdictError(provider, stage, key, "empty output");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = allowRegexSalvage ? text.match(/\{[\s\S]*\}/) : null;
    if (!m) {
      throw new MissingVerdictError(provider, stage, key, `non-JSON output: ${text.slice(0, 300)}`);
    }
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      throw new MissingVerdictError(provider, stage, key, `non-JSON output: ${text.slice(0, 300)}`);
    }
  }
  // Claude --output-format json may wrap the schema result in { result: {...} | "..." }
  if (parsed && typeof parsed === "object" && parsed.result != null) {
    const r = parsed.result;
    if (typeof r === "string") {
      try {
        parsed = JSON.parse(r);
      } catch {
        /* keep envelope; validation will fail clearly */
      }
    } else if (typeof r === "object") {
      parsed = r;
    }
  }
  if (parsed && typeof parsed === "object" && parsed.structured_output && typeof parsed.structured_output === "object") {
    parsed = parsed.structured_output;
  }
  return parsed;
}

/**
 * Parse judge stdout that should be a JSON object (or contain one).
 */
export function parseJudgeJson(out, { provider, key, glossary, allowRegexSalvage = false }) {
  const parsed = parseJsonObject(out, { provider, stage: "judge", key, allowRegexSalvage });
  return validateJudgeParsed(parsed, { provider, key, glossary });
}

/**
 * Parse a compare verdict. A pick outside the labels (or absent) is a
 * missing verdict, never a pass. "none" means the judge found no option
 * acceptable (recorded as an explicit abstain).
 */
export function parseCompareJson(out, { provider, key, labels, allowRegexSalvage = false }) {
  const parsed = parseJsonObject(out, { provider, stage: "compare", key, allowRegexSalvage });
  const pick = typeof parsed?.pick === "string" ? parsed.pick.trim() : null;
  if (!pick || (pick !== "none" && !labels.includes(pick))) {
    throw new MissingVerdictError(
      provider,
      "compare",
      key,
      `pick ${JSON.stringify(parsed?.pick)} is not one of ${[...labels, "none"].join("/")}`,
    );
  }
  return { key, pick, rationale: String(parsed.rationale ?? "") };
}
