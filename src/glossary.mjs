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
    if (entry.origin != null) {
      const o = entry.origin;
      if (typeof o !== "object" || Array.isArray(o) || typeof o.via !== "string" || !o.via) {
        throw new Error(`Glossary entry[${i}].origin must be { via, keys? }`);
      }
      if (o.keys != null && (!Array.isArray(o.keys) || !o.keys.every((k) => typeof k === "string"))) {
        throw new Error(`Glossary entry[${i}].origin.keys must be strings`);
      }
    }
  });
  if (doc.declined != null) {
    if (!Array.isArray(doc.declined)) throw new Error("Glossary.declined must be an array");
    doc.declined.forEach((d, i) => {
      if (!d || typeof d.source !== "string" || !d.source || typeof d.why !== "string") {
        throw new Error(`Glossary.declined[${i}] must be { source, why }`);
      }
    });
  }
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
  const cand = String(candidate ?? "").normalize("NFC").toLowerCase();
  for (const e of glossary.entries) {
    if (!sourceHasTerm(source, e.source)) continue;
    for (const r of e.rejected) {
      if (r.term && cand.includes(r.term.normalize("NFC").toLowerCase())) {
        hits.push({ term: r.term, why: r.why, source: e.source });
      }
    }
  }
  return hits;
}

const WORD_CHAR = "[\\p{L}\\p{N}]";
const termRegexCache = new Map();

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** English inflections of a term's last word: s/es/'s/d/ed/ing, e-drop, y→ies/ied, doubled consonant. */
function lastWordPattern(word) {
  const forms = [`${escapeRe(word)}(?:s|es|'s|’s|d|ed|ing|ings)?`];
  if (/[a-z]e$/.test(word)) forms.push(`${escapeRe(word.slice(0, -1))}(?:ing|ings)`);
  if (/[^aeiou]y$/.test(word)) forms.push(`${escapeRe(word.slice(0, -1))}(?:ies|ied)`);
  if (/[^aeiou][aeiou][bdgklmnprt]$/.test(word)) forms.push(`${escapeRe(word + word.at(-1))}(?:ed|ing|ings)`);
  return forms.length === 1 ? forms[0] : `(?:${forms.join("|")})`;
}

function termBody(term) {
  const words = String(term ?? "").normalize("NFC").trim().toLowerCase().split(/[\s\-\u2010-\u2013]+/u).filter(Boolean);
  if (!words.length) return null;
  return [...words.slice(0, -1).map(escapeRe), lastWordPattern(words.at(-1))].join("[-\\s\\u2010-\\u2013]?");
}

function cachedRegex(kind, term, build) {
  const key = `${kind}\u0000${String(term ?? "").normalize("NFC").trim().toLowerCase()}`;
  if (!termRegexCache.has(key)) {
    const body = termBody(term);
    termRegexCache.set(key, body ? build(body) : null);
  }
  return termRegexCache.get(key);
}

/**
 * Regex that finds an English glossary term in English text: whole words only, case-insensitive,
 * hyphen/space/no-space variants ("pre-compose", "precompose") and common English inflections of
 * the last word ("layers", "skinning", "composing").
 */
export function termRegex(term) {
  return cachedRegex("find", term, (body) => new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, "iu"));
}

/**
 * A lowercase substring every match of `term` contains: the first word of a multi-word term, or a
 * single word without the final e/y its inflections drop. A cheap test before the regex.
 */
function termNeedle(term) {
  const words = String(term ?? "").normalize("NFC").trim().toLowerCase().split(/[\s\-\u2010-\u2013]+/u).filter(Boolean);
  const needle = words[0] ?? "";
  return words.length === 1 && /[a-z][ey]$/.test(needle) ? needle.slice(0, -1) : needle;
}

/** Per-glossary matchers, built once per entries array. */
const compiledEntries = new WeakMap();

function matchers(entries) {
  if (!compiledEntries.has(entries)) {
    compiledEntries.set(
      entries,
      entries.map((e) => ({ entry: e, needle: termNeedle(e.source), re: termRegex(e.source) })),
    );
  }
  return compiledEntries.get(entries);
}

/** Whether English `text` contains the glossary term `term` (see termRegex). */
export function sourceHasTerm(text, term) {
  const re = termRegex(term);
  return Boolean(re && re.test(String(text ?? "").normalize("NFC")));
}

/** Whether two English terms are the same term ("Layers" and "layer", "precompose" and "pre-compose"). */
export function sameTerm(a, b) {
  const exact = (text, term) => {
    const re = cachedRegex("exact", term, (body) => new RegExp(`^(?:${body})$`, "iu"));
    return Boolean(re && re.test(String(text ?? "").normalize("NFC").trim()));
  };
  return exact(a, b) || exact(b, a);
}

/**
 * The part of a glossary that applies to some English strings: the entries whose source term
 * appears in at least one of them. Providers get only this slice, and the result cache keys on it,
 * so adding an entry re-runs only the strings that use the new term. `declined` never reaches a
 * provider. Returns null when no entry applies.
 * @param {object|null} glossary
 * @param {string[]} sources
 */
export function glossarySlice(glossary, sources) {
  if (!glossary?.entries?.length) return null;
  const texts = sources.map((s) => String(s ?? "").normalize("NFC"));
  const lowered = texts.map((t) => t.toLowerCase());
  const entries = [];
  for (const m of matchers(glossary.entries)) {
    if (m.re && texts.some((t, i) => lowered[i].includes(m.needle) && m.re.test(t))) entries.push(m.entry);
  }
  if (!entries.length) return null;
  return { schemaVersion: glossary.schemaVersion, locale: glossary.locale, entries };
}
