import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REQUIRED_ENTRY_FIELDS = [
  "source",
  "locale",
  "productMeaning",
  "relatedTerms",
  "practitionerTerm",
  "approved",
  "rejected",
];

/**
 * Validate glossary schema v0. Throws with a clear message on failure.
 */
export function validateGlossary(doc) {
  if (!doc || typeof doc !== "object") {
    throw new Error("Glossary must be a JSON object");
  }
  if (doc.schemaVersion !== "0") {
    throw new Error(
      `Unsupported glossary schemaVersion "${doc.schemaVersion}" (expected "0")`,
    );
  }
  if (typeof doc.locale !== "string" || !doc.locale) {
    throw new Error("Glossary.locale must be a non-empty string");
  }
  if (doc.version != null && typeof doc.version !== "string") {
    throw new Error("Glossary.version must be a string when present");
  }
  if (!Array.isArray(doc.entries)) {
    throw new Error("Glossary.entries must be an array");
  }
  doc.entries.forEach((entry, i) => {
    for (const field of REQUIRED_ENTRY_FIELDS) {
      if (!(field in entry)) {
        throw new Error(`Glossary entry[${i}] missing required field "${field}"`);
      }
    }
    if (typeof entry.source !== "string" || !entry.source) {
      throw new Error(`Glossary entry[${i}].source must be a non-empty string`);
    }
    if (typeof entry.locale !== "string" || !entry.locale) {
      throw new Error(`Glossary entry[${i}].locale must be a non-empty string`);
    }
    if (typeof entry.productMeaning !== "string") {
      throw new Error(`Glossary entry[${i}].productMeaning must be a string`);
    }
    if (typeof entry.practitionerTerm !== "string") {
      throw new Error(`Glossary entry[${i}].practitionerTerm must be a string`);
    }
    if (!Array.isArray(entry.relatedTerms)) {
      throw new Error(`Glossary entry[${i}].relatedTerms must be an array`);
    }
    if (!entry.relatedTerms.every((t) => typeof t === "string")) {
      throw new Error(`Glossary entry[${i}].relatedTerms must be strings`);
    }
    if (typeof entry.approved !== "boolean") {
      throw new Error(`Glossary entry[${i}].approved must be a boolean`);
    }
    if (!Array.isArray(entry.rejected)) {
      throw new Error(`Glossary entry[${i}].rejected must be an array`);
    }
    entry.rejected.forEach((r, j) => {
      if (!r || typeof r.term !== "string" || typeof r.why !== "string") {
        throw new Error(
          `Glossary entry[${i}].rejected[${j}] must be { term, why }`,
        );
      }
    });
  });
  return doc;
}

export async function loadGlossary(path) {
  const abs = resolve(path);
  const raw = JSON.parse(await readFile(abs, "utf8"));
  return validateGlossary(raw);
}

/**
 * Build a compact prompt block from approved / rejected glossary entries.
 */
export function glossaryPromptBlock(glossary) {
  if (!glossary?.entries?.length) return "";
  const lines = [`Glossary (${glossary.locale}):`];
  for (const e of glossary.entries) {
    const status = e.approved ? "APPROVED" : "NOT APPROVED";
    lines.push(
      `- "${e.source}" → "${e.practitionerTerm}" [${status}] — ${e.productMeaning}`,
    );
    for (const r of e.rejected) {
      lines.push(`  ✗ reject "${r.term}": ${r.why}`);
    }
  }
  return lines.join("\n");
}

/**
 * Deterministic glossary check: rejected terms that appear in the candidate
 * for an entry whose source term appears in the English source.
 * Case-insensitive. Returns [{ term, why, source }].
 */
export function findRejectedTerms(source, candidate, glossary) {
  const hits = [];
  if (!glossary?.entries?.length) return hits;
  const src = String(source ?? "").toLowerCase();
  const cand = String(candidate ?? "").toLowerCase();
  for (const e of glossary.entries) {
    if (!src.includes(e.source.toLowerCase())) continue;
    for (const r of e.rejected) {
      if (r.term && cand.includes(r.term.toLowerCase())) {
        hits.push({ term: r.term, why: r.why, source: e.source });
      }
    }
  }
  return hits;
}
