/**
 * Term-extraction output schema and fail-closed parsing for the CLI
 * adapters (openrouter validates against the same schema per batch).
 */

import { loadSchema, validate } from "../json-schema.mjs";
import { MissingVerdictError } from "./contract.mjs";
import { bareSchema, parseJsonObject } from "./judge-schema.mjs";

export const TERMS_OUTPUT_SCHEMA = bareSchema(loadSchema("term-extraction.v1.json"));

/** Trim each term's fields; the schema has already checked their types. */
export function cleanTerms(terms) {
  return terms.map((t) => ({
    source: t.source.trim(),
    target: t.target.trim(),
    base: t.base.trim(),
    productMeaning: t.productMeaning.trim(),
  }));
}

/** Parse a CLI's terms answer. Anything but a schema-valid { terms: [...] } is a missing verdict. */
export function parseTermsJson(out, { provider, key, allowRegexSalvage = false }) {
  const parsed = parseJsonObject(out, { provider, stage: "terms", key, allowRegexSalvage });
  const { ok, errors } = validate(parsed, TERMS_OUTPUT_SCHEMA);
  if (!ok) throw new MissingVerdictError(provider, "terms", key, errors.slice(0, 3).join("; "));
  return { key, terms: cleanTerms(parsed.terms) };
}
