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
        throw new Error(`Glossary entry[${i}].origin must be { via, from?, keys? }`);
      }
      if (o.keys != null && (!Array.isArray(o.keys) || !o.keys.every((k) => typeof k === "string"))) {
        throw new Error(`Glossary entry[${i}].origin.keys must be strings`);
      }
      if (o.from != null && typeof o.from !== "string") {
        throw new Error(`Glossary entry[${i}].origin.from must be a string`);
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
const SEP_CLASS = "[-\\s\\u2010-\\u2013]";
const SEP_SPLIT = /[\s\-‐-–]+/u;
const termRegexCache = new Map();

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A term's words, lowercased. Hyphens and spaces between them don't matter for matching. */
function termWords(term) {
  return String(term ?? "").normalize("NFC").trim().toLowerCase().split(SEP_SPLIT).filter(Boolean);
}

/** `s` with an optional hyphen or space between every two letters: "precompose" ⇄ "pre-compose". */
function loose(s) {
  return [...s].map(escapeRe).join(`${SEP_CLASS}?`);
}

/**
 * Pattern for a term: its letters with optional separators, plus English inflections of the last
 * word. Short words get few: two letters ("US", "IT") none, three letters only the plural, so
 * "car" doesn't match "card" and "set" doesn't match "settings".
 */
function termBody(term) {
  const words = termWords(term);
  if (!words.length) return null;
  const head = words.slice(0, -1).join("");
  const w = words.at(-1);
  const sibilant = /(?:s|x|z|ch|sh|o)$/.test(w);
  const forms = [];
  if (w.length <= 2) forms.push([w, ""]);
  else if (w.length === 3) forms.push([w, sibilant ? "(?:s|es|'s|’s)?" : "(?:s|'s|’s)?"]);
  else {
    const suffixes = ["s", "'s", "’s", ...(sibilant ? ["es"] : []), ...(w.endsWith("e") ? ["d"] : ["ed", "ing", "ings"])];
    forms.push([w, `(?:${suffixes.join("|")})?`]);
    if (w.endsWith("e")) forms.push([w.slice(0, -1), "(?:ing|ings)"]); // compose → composing
    if (/[^aeiou]y$/.test(w)) forms.push([w.slice(0, -1), "(?:ies|ied)"]); // copy → copies
    if (/[^aeiou][aeiou][bdgklmnprt]$/.test(w)) forms.push([w + w.at(-1), "(?:ed|ing)"]); // skin → skinning
  }
  const alts = forms.map(([stem, suffix]) => loose(head + stem) + suffix);
  return alts.length === 1 ? alts[0] : `(?:${alts.join("|")})`;
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
 * hyphen/space/no-space variants in either direction ("pre-compose" ⇄ "precompose") and common
 * English inflections of the last word ("layers", "skinning", "composing").
 */
export function termRegex(term) {
  return cachedRegex("find", term, (body) => new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, "iu"));
}

/**
 * A lowercase string every match of `term` contains once hyphens and spaces are removed: the term
 * without separators, minus a final e/y that its inflections drop. A cheap test before the regex.
 */
function termNeedle(term) {
  const words = termWords(term);
  const squashed = words.join("");
  return (words.at(-1)?.length ?? 0) > 3 && /[ey]$/.test(squashed) ? squashed.slice(0, -1) : squashed;
}

/** Lowercase text without hyphens and spaces, the haystack for termNeedle. */
function squash(text) {
  return text.toLowerCase().replace(/[\s\-‐-–]+/gu, "");
}

/** Per-glossary matchers (an entry's source and related terms), built once per entries array. */
const compiledEntries = new WeakMap();

function matchers(entries) {
  if (!compiledEntries.has(entries)) {
    compiledEntries.set(
      entries,
      entries.map((e) => ({
        entry: e,
        terms: [e.source, ...(Array.isArray(e.relatedTerms) ? e.relatedTerms : [])]
          .map((t) => ({ needle: termNeedle(t), re: termRegex(t) }))
          .filter((t) => t.re),
      })),
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
 * Two terms that are the same term (sameTerm) share their first three letters once hyphens and
 * spaces are removed: inflections only change the end of the last word. An index bucketed on that
 * keeps lookups across large glossaries fast.
 */
const bucketOf = (term) => squash(String(term ?? "").normalize("NFC")).slice(0, 3);

/**
 * An index for finding an item by term with sameTerm semantics.
 * @param {object[]} items
 * @param {(item: object) => string[]} termsOf - the terms an item answers to
 */
export function termIndex(items = [], termsOf = (x) => [x]) {
  const buckets = new Map();
  const add = (item) => {
    for (const t of termsOf(item)) {
      const b = bucketOf(t);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push([t, item]);
    }
  };
  for (const item of items) add(item);
  return {
    add,
    find(term) {
      for (const [t, item] of buckets.get(bucketOf(term)) ?? []) if (sameTerm(t, term)) return item;
      return undefined;
    },
  };
}

/**
 * Keys of `enMap` whose English contains any of `terms`. Prefilters with a substring test, so it
 * stays fast across a whole catalog.
 * @param {Record<string,string>} enMap
 * @param {string[]} terms
 */
export function keysUsingTerm(enMap, terms) {
  const ms = terms.map((t) => ({ needle: termNeedle(t), re: termRegex(t) })).filter((m) => m.re);
  const out = [];
  for (const { key, text, flat } of preparedCatalog(enMap)) {
    if (ms.some((m) => flat.includes(m.needle) && m.re.test(text))) out.push(key);
  }
  return out.sort();
}

/** A catalog's strings normalized once (NFC, plus the squashed haystack), reused across term lookups. */
const preparedCatalogs = new WeakMap();

function preparedCatalog(enMap) {
  let prepared = preparedCatalogs.get(enMap);
  if (!prepared) {
    prepared = Object.entries(enMap).map(([key, v]) => {
      const text = String(v ?? "").normalize("NFC");
      return { key, text, flat: squash(text) };
    });
    preparedCatalogs.set(enMap, prepared);
  }
  return prepared;
}

/**
 * The part of a glossary that applies to some English strings: the entries whose source term, or
 * one of their related terms, appears in at least one of them. Providers get only this slice, and
 * the result cache keys on it, so adding an entry re-runs only the strings that use the new term.
 * `declined` never reaches a provider. Returns null when no entry applies.
 * @param {object|null} glossary
 * @param {string[]} sources
 */
export function glossarySlice(glossary, sources) {
  if (!glossary?.entries?.length) return null;
  const texts = sources.map((s) => String(s ?? "").normalize("NFC"));
  const flats = texts.map(squash);
  const entries = [];
  for (const m of matchers(glossary.entries)) {
    if (m.terms.some((t) => texts.some((text, i) => flats[i].includes(t.needle) && t.re.test(text)))) entries.push(m.entry);
  }
  if (!entries.length) return null;
  return { schemaVersion: glossary.schemaVersion, locale: glossary.locale, entries };
}
