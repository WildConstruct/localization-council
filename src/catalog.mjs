import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Default protected-token patterns (must survive translation).
 *  Simple `{name}` only — richer ICU MessageFormat (plural/select/number/…)
 *  is handled by `checkIcuStructure` in `./icu.mjs`.
 */
export const DEFAULT_PROTECTED_PATTERNS = [
  /\{\{[^}]+\}\}/g, // {{name}}, {{ offer.foo }}, etc.
  /%[sdif]/g, // printf-style
  /\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, // {name} simple ICU (see icu.mjs for typed forms)
];

/**
 * Normalize a string→string (or nested { text }) object map into id → text.
 */
function normalizeStringMap(obj) {
  const map = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      map[k] = v;
    } else if (v && typeof v === "object" && typeof v.text === "string") {
      map[k] = v.text;
    } else {
      throw new Error(`Catalog entry "${k}" is not a string or { text }`);
    }
  }
  return map;
}

/**
 * Normalize a catalog into an id → string map.
 *
 * Accepts:
 * - Flat { id: "text" } maps
 * - [{ id, text }] / [{ key, value }] lists
 * - Page wrappers (the English string doubles as its id):
 *   { page, locale, strings: ["Skip to content", ...] }  → id === source text
 *   { page, locale, strings: { "Skip…": "Zum…" } }       → normalize the map
 *   When `strings` is present, metadata keys (page/locale/_comment/…) are ignored.
 */
export function normalizeCatalog(raw) {
  if (Array.isArray(raw)) {
    const map = {};
    for (const item of raw) {
      const id = item.id ?? item.key ?? item.name;
      const text = item.text ?? item.value ?? item.source ?? item.en;
      if (!id || text == null) {
        throw new Error(
          `Catalog list entry missing id/key and text/value: ${JSON.stringify(item)}`,
        );
      }
      const sid = String(id);
      if (Object.prototype.hasOwnProperty.call(map, sid)) {
        throw new Error(`Duplicate catalog id "${sid}"`);
      }
      map[sid] = String(text);
    }
    return map;
  }
  if (raw && typeof raw === "object") {
    // Page wrapper: prefer `.strings` when present.
    if (Object.prototype.hasOwnProperty.call(raw, "strings")) {
      const strings = raw.strings;
      if (Array.isArray(strings)) {
        const map = {};
        for (const item of strings) {
          if (typeof item !== "string") {
            throw new Error(
              `Catalog strings[] entry must be a string: ${JSON.stringify(item)}`,
            );
          }
          if (Object.prototype.hasOwnProperty.call(map, item)) {
            throw new Error(`Duplicate catalog id "${item}"`);
          }
          map[item] = item; // exact-substring: id === source text
        }
        return map;
      }
      if (strings && typeof strings === "object") {
        return normalizeStringMap(strings);
      }
      throw new Error("Catalog.strings must be an array of strings or a string map");
    }
    return normalizeStringMap(raw);
  }
  throw new Error("Catalog must be an object map or array of entries");
}

export async function loadCatalog(path) {
  const abs = resolve(path);
  const raw = JSON.parse(await readFile(abs, "utf8"));
  return normalizeCatalog(raw);
}

/**
 * Extract protected tokens from a source string using configurable patterns.
 */
export function extractProtectedTokens(
  text,
  patterns = DEFAULT_PROTECTED_PATTERNS,
) {
  const found = [];
  const covered = []; // [start, end) ranges already claimed by an earlier pattern
  for (const re of patterns) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const global = new RegExp(re.source, flags);
    let m;
    while ((m = global.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      // Skip overlaps so {{name}} is not also reported as {name}.
      if (covered.some(([s, e]) => start < e && end > s)) continue;
      found.push(m[0]);
      covered.push([start, end]);
    }
  }
  return found;
}

/**
 * Verify that every protected token from source still appears in the candidate.
 * Returns { ok, missing }.
 */
export function checkProtectedTokens(
  source,
  candidate,
  patterns = DEFAULT_PROTECTED_PATTERNS,
) {
  const expected = extractProtectedTokens(source, patterns);
  const missing = expected.filter((t) => !candidate.includes(t));
  return { ok: missing.length === 0, missing, expected };
}

/**
 * Compute keys present in source but missing or empty in target.
 */
export function computeMissingKeys(sourceMap, targetMap) {
  const missing = [];
  const untranslated = [];
  for (const [key, en] of Object.entries(sourceMap)) {
    if (!(key in targetMap) || targetMap[key] == null || targetMap[key] === "") {
      missing.push({ key, source: en, reason: "missing" });
    } else if (targetMap[key] === en) {
      untranslated.push({ key, source: en, reason: "identical_to_source" });
    }
  }
  return { missing, untranslated, missingKeys: missing.map((m) => m.key) };
}

/**
 * Diff two catalog files on disk.
 */
export async function diffCatalogFiles(sourcePath, targetPath) {
  const source = await loadCatalog(sourcePath);
  const target = await loadCatalog(targetPath);
  const result = computeMissingKeys(source, target);
  return {
    sourcePath,
    targetPath,
    sourceCount: Object.keys(source).length,
    targetCount: Object.keys(target).length,
    ...result,
  };
}
