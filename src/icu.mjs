/**
 * Lightweight ICU MessageFormat structure helpers for Localization Council.
 *
 * Parses common product-UI patterns without an ICU4J/ICU4C dependency:
 *   {name}
 *   {n, number[, style]}
 *   {d, date|time[, style]}
 *   {n, plural|select|selectordinal, branchKey {…} …}
 *
 * Nested plural/select bodies are walked so nested argument names and `#`
 * (plural number placeholder) are part of the structure check.
 *
 * Limitations (intentional — not a full FormatJS/ICU AST):
 * - Apostrophe escaping is best-effort (`'…'` / `''`); exotic quoting may miss edges.
 * - Number/date skeletons are not semantically validated (only brace balance + type keyword).
 * - `choice` and other rare types are treated as opaque typed args (name + keyword).
 * - Deeply malformed input may yield incomplete extraction; compare fails closed when
 *   source structure is missing from the candidate.
 * - Mustache `{{…}}` is skipped here (handled by catalog protected-token checks).
 */

/** Type keywords we recognize and require to survive translation. */
export const ICU_TYPE_KEYWORDS = new Set([
  "plural",
  "select",
  "selectordinal",
  "number",
  "date",
  "time",
]);

/**
 * Prompt fragment for translate / BT system prompts.
 * Instructs models to preserve MessageFormat structure while translating prose.
 */
export const ICU_PRESERVE_PROMPT =
  "Preserve ICU MessageFormat structure exactly: argument names; type keywords " +
  "(plural, select, selectordinal, number, date, time); plural/select branch keys " +
  "(one, other, =0, …); and # where used as the plural number placeholder. " +
  "Translate only human-readable text inside branches. " +
  "Also preserve {{mustache}} placeholders and printf tokens (%s, %d, …).";

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*/;
const BRANCH_KEY = /^(?:=\d+|[a-zA-Z_][a-zA-Z0-9_]*)/;

/**
 * @typedef {object} IcuArg
 * @property {string} name
 * @property {string|null} type - null for simple {name}
 * @property {string[]|null} branches - sorted unique branch keys when plural/select*
 * @property {boolean} hasHash - true if `#` appears in a plural/selectordinal body
 * @property {number} start
 * @property {number} end - exclusive index after closing `}`
 */

/**
 * Extract ICU arguments (including nested) from a message string.
 * @param {string} text
 * @returns {IcuArg[]}
 */
export function extractIcuArgs(text) {
  if (typeof text !== "string" || !text.includes("{")) return [];
  return parseMessageBody(text, 0, text.length);
}

/**
 * Compare ICU MessageFormat structure between source and candidate.
 * @param {{ locale?: string }} [options]
 * @returns {{ ok: boolean, missing: string[], extras: string[], details: string[] }}
 */
export function checkIcuStructure(source, candidate, { locale } = {}) {
  const srcArgs = extractIcuArgs(source ?? "");
  const candArgs = extractIcuArgs(candidate ?? "");
  const missing = [];
  const extras = [];
  const details = [];

  // Multiset of argument names
  const srcNames = countMap(srcArgs.map((a) => a.name));
  const candNames = countMap(candArgs.map((a) => a.name));
  for (const [name, n] of srcNames) {
    const have = candNames.get(name) || 0;
    if (have < n) {
      missing.push(`arg:${name}`);
      details.push(
        have === 0
          ? `missing argument "${name}"`
          : `argument "${name}" expected ${n}×, found ${have}×`,
      );
    }
  }
  for (const [name, n] of candNames) {
    const expect = srcNames.get(name) || 0;
    if (n > expect) {
      extras.push(`arg:${name}`);
      details.push(
        expect === 0
          ? `extra argument "${name}"`
          : `argument "${name}" expected ${expect}×, found ${n}×`,
      );
    }
  }

  // Match typed args by name (in order among same name)
  const candByName = groupByName(candArgs);
  const srcByName = groupByName(srcArgs);
  for (const [name, srcList] of srcByName) {
    const candList = candByName.get(name) || [];
    const n = Math.min(srcList.length, candList.length);
    for (let i = 0; i < n; i++) {
      const s = srcList[i];
      const c = candList[i];
      if (s.type && s.type !== c.type) {
        missing.push(`type:${name}:${s.type}`);
        details.push(
          `argument "${name}" expected type "${s.type}", found "${c.type ?? "simple"}"`,
        );
      } else if (!s.type && c.type) {
        // Source was simple; candidate added a type — unusual, flag as extra structure
        extras.push(`type:${name}:${c.type}`);
        details.push(
          `argument "${name}" was simple in source but candidate has type "${c.type}"`,
        );
      }

      if (s.branches && s.branches.length) {
        const candBranches = new Set(c.branches || []);
        const localeCategories = pluralCategories(locale, s.type);
        for (const b of s.branches) {
          const unusedLocaleCategory =
            localeCategories && b !== "other" && /^(?:zero|one|two|few|many)$/.test(b) && !localeCategories.has(b);
          if (!candBranches.has(b) && !unusedLocaleCategory) {
            missing.push(`branch:${name}:${b}`);
            details.push(`argument "${name}" missing branch "${b}"`);
          }
        }
        for (const b of c.branches || []) {
          const validLocaleCategory = localeCategories && !b.startsWith("=") && localeCategories.has(b);
          if (!s.branches.includes(b) && !validLocaleCategory) {
            extras.push(`branch:${name}:${b}`);
            details.push(`argument "${name}" has extra branch "${b}"`);
          }
        }
      }

      if (s.hasHash && !c.hasHash) {
        missing.push(`hash:${name}`);
        details.push(
          `argument "${name}" is missing "#" plural number placeholder`,
        );
      }
    }
  }

  return {
    ok: missing.length === 0 && extras.length === 0,
    missing,
    extras,
    details,
  };
}

function pluralCategories(locale, type) {
  if (!locale || (type !== "plural" && type !== "selectordinal")) return null;
  try {
    if (!Intl.PluralRules.supportedLocalesOf([locale]).length) return null;
    const rules = new Intl.PluralRules(locale, {
      type: type === "selectordinal" ? "ordinal" : "cardinal",
    });
    return new Set(rules.resolvedOptions().pluralCategories);
  } catch {
    return null;
  }
}

function countMap(items) {
  const m = new Map();
  for (const x of items) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

function groupByName(args) {
  const m = new Map();
  for (const a of args) {
    if (!m.has(a.name)) m.set(a.name, []);
    m.get(a.name).push(a);
  }
  return m;
}

function skipQuoted(text, i) {
  // ICU: '' → literal quote; '…' → quoted literal (may contain braces)
  if (text[i] !== "'") return i;
  i++;
  if (i < text.length && text[i] === "'") return i + 1;
  while (i < text.length && text[i] !== "'") i++;
  return i < text.length ? i + 1 : i;
}

function skipWs(text, i, end) {
  while (i < end && /\s/.test(text[i])) i++;
  return i;
}

/**
 * Parse one `{…}` argument starting at `start` (must be `{`).
 * Returns null if it does not look like an ICU arg.
 */
function parseArg(text, start, end) {
  if (text[start] !== "{") return null;
  let i = start + 1;
  i = skipWs(text, i, end);

  const nameMatch = text.slice(i, end).match(IDENT);
  if (!nameMatch) return null;
  const name = nameMatch[0];
  i += name.length;
  i = skipWs(text, i, end);

  if (i >= end) return null;

  // Simple {name}
  if (text[i] === "}") {
    return {
      name,
      type: null,
      branches: null,
      hasHash: false,
      start,
      end: i + 1,
      nested: [],
    };
  }

  if (text[i] !== ",") return null;
  i++;
  i = skipWs(text, i, end);

  const typeMatch = text.slice(i, end).match(IDENT);
  if (!typeMatch) return null;
  const type = typeMatch[0];
  i += type.length;
  i = skipWs(text, i, end);

  const isSelectLike =
    type === "plural" || type === "select" || type === "selectordinal";

  if (isSelectLike) {
    // Optional comma after type before branches
    if (i < end && text[i] === ",") {
      i++;
      i = skipWs(text, i, end);
    }
    const parsed = parseBranches(text, i, end);
    if (!parsed) return null;
    return {
      name,
      type,
      branches: [...new Set(parsed.keys)].sort(branchKeySort),
      hasHash: parsed.hasHash,
      start,
      end: parsed.end,
      nested: parsed.nested,
    };
  }

  // number / date / time / unknown typed: consume style until matching `}`
  // Style may include commas and colons but not nested `{` in common UI cases.
  // Still brace-balance for safety.
  const closed = consumeBalanced(text, i, end);
  if (closed < 0) return null;
  return {
    name,
    type,
    branches: null,
    hasHash: false,
    start,
    end: closed,
    nested: [],
  };
}

/**
 * From position just after type[,], parse `key {body}` branches until the
 * closing `}` of the outer arg. Returns { keys, hasHash, nested, end }.
 */
function parseBranches(text, i, end) {
  const keys = [];
  const nested = [];
  let hasHash = false;

  while (i < end) {
    i = skipWs(text, i, end);
    if (i >= end) return null;
    if (text[i] === "}") {
      return { keys, hasHash, nested, end: i + 1 };
    }

    const keyMatch = text.slice(i, end).match(BRANCH_KEY);
    if (!keyMatch) return null;
    const key = keyMatch[0];
    i += key.length;
    i = skipWs(text, i, end);
    if (i >= end || text[i] !== "{") return null;

    const bodyStart = i + 1;
    const bodyEnd = findMatchingBrace(text, i, end);
    if (bodyEnd < 0) return null;

    // Walk body for nested args + bare `#`
    const bodyArgs = parseMessageBody(text, bodyStart, bodyEnd);
    nested.push(...bodyArgs);
    if (bodyHasHash(text, bodyStart, bodyEnd)) hasHash = true;

    keys.push(key);
    i = bodyEnd + 1; // past body's `}`
  }
  return null;
}

function bodyHasHash(text, start, end) {
  let i = start;
  while (i < end) {
    if (text[i] === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (text[i] === "{" && text[i + 1] === "{") {
      const close = text.indexOf("}}", i + 2);
      i = close === -1 || close >= end ? end : close + 2;
      continue;
    }
    if (text[i] === "{") {
      const close = findMatchingBrace(text, i, end);
      i = close < 0 ? end : close + 1;
      continue;
    }
    if (text[i] === "#") return true;
    i++;
  }
  return false;
}

/** Find index of `}` matching `{` at `open`. */
function findMatchingBrace(text, open, end) {
  let depth = 0;
  let i = open;
  while (i < end) {
    if (text[i] === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (text[i] === "{") {
      depth++;
      i++;
      continue;
    }
    if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * From `i` (inside a typed arg after type), consume until the arg's closing `}`
 * with brace balance starting at depth 1 (outer `{` already opened).
 * Returns exclusive end index after `}`, or -1.
 */
function consumeBalanced(text, i, end) {
  let depth = 1; // already inside outer `{`
  while (i < end) {
    if (text[i] === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (text[i] === "{") {
      depth++;
      i++;
      continue;
    }
    if (text[i] === "}") {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return -1;
}

function parseMessageBody(text, start, end) {
  const args = [];
  let i = start;
  while (i < end) {
    const ch = text[i];
    if (ch === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === "{" && text[i + 1] === "{") {
      const close = text.indexOf("}}", i + 2);
      i = close === -1 || close >= end ? end : close + 2;
      continue;
    }
    if (ch === "{") {
      const arg = parseArg(text, i, end);
      if (!arg) {
        i++;
        continue;
      }
      // Flatten: this arg + nested args from its branches
      const { nested, ...top } = arg;
      args.push(top);
      if (nested?.length) args.push(...nested);
      i = arg.end;
      continue;
    }
    i++;
  }
  return args;
}

/** Sort branch keys: =N numeric, then lexical (other last among words is fine). */
function branchKeySort(a, b) {
  const aEq = a.startsWith("=");
  const bEq = b.startsWith("=");
  if (aEq && bEq) return Number(a.slice(1)) - Number(b.slice(1));
  if (aEq) return -1;
  if (bEq) return 1;
  if (a === "other") return 1;
  if (b === "other") return -1;
  return a.localeCompare(b);
}
