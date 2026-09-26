/**
 * Deterministic mock providers for offline demos, tests, and CI.
 * No network, no API keys, no CLIs.
 *
 * Three variants let the optional post-escalate stages run offline:
 *   mock        primary translator; makes three deliberate "fluent mistakes"
 *               on the German toy catalog so the demo shows real escalations
 *   mock:alt    alternative translator (mostly the approved wording)
 *   mock:third  third translator (a different, sometimes weaker, wording)
 *
 * For any other locale every variant returns "[<locale>] <source>".
 */

import { perItem } from "./contract.mjs";

/** Approved reference wording (German). mock:alt follows this. */
const DE_REFERENCE = {
  Play: "Abspielen",
  Pause: "Pause",
  "Scrub playhead": "Playhead schrubben",
  "New composition": "Neue Komposition",
  Duration: "Dauer",
  "Add layer": "Ebene hinzufügen",
  "Pre-compose": "Vorkomponieren",
  "Apply effect": "Effekt anwenden",
  "Mask path": "Maskenpfad",
  "Add to render queue": "Zur Renderwarteschlange hinzufügen",
  "Export sequence": "Sequenz exportieren",
  "Fit to viewport": "An Viewport anpassen",
  "Onion skin": "Onion Skin",
  "Ease in / out": "Ease In / Out",
  Transform: "Transformation",
  "Anchor point": "Ankerpunkt",
  "Keyboard shortcuts": "Tastenkürzel",
  Ready: "Bereit",
  "Rendering…": "Wird gerendert…",
  "GPU unavailable — falling back to CPU": "GPU nicht verfügbar — Fallback auf CPU",
};

/** Per-variant differences from the reference. */
const DE_VARIANTS = {
  // Fluent mistakes a real model makes: a rejected calque, a literal
  // phrase that breaks practitioner vocabulary, and a meaning drift.
  mock: {
    "Onion skin": "Zwiebelschale",
    "Pre-compose": "Vorab zusammenstellen",
    "Rendering…": "Wird verarbeitet…",
  },
  "mock:alt": {},
  "mock:third": {
    "Pre-compose": "Verschachteln",
    "Rendering…": "Rendern…",
  },
};

/** Literal back-translations for non-reference wording. */
const DE_LITERAL_BT = {
  Zwiebelschale: "Onion skin",
  "Vorab zusammenstellen": "Assemble in advance",
  "Wird verarbeitet…": "Processing…",
  Verschachteln: "Nest",
  "Rendern…": "Rendering…",
};

const DE_REVERSE = Object.fromEntries(
  Object.entries(DE_REFERENCE).map(([en, de]) => [de, en]),
);

export const MOCK_VARIANTS = Object.freeze(["mock", "mock:alt", "mock:third"]);

function translateOne(variant, text, locale) {
  if (!locale.startsWith("de")) return `[${locale}] ${text}`;
  const override = DE_VARIANTS[variant]?.[text];
  if (override) return override;
  return DE_REFERENCE[text] ?? `[${locale}] ${text}`;
}

function backtranslateOne(text, locale) {
  if (DE_LITERAL_BT[text]) return DE_LITERAL_BT[text];
  if (DE_REVERSE[text]) return DE_REVERSE[text];
  return text.replace(new RegExp(`^\\[${escapeRe(locale)}\\]\\s*`), "");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Simple hash for deterministic jitter from a string. */
function hashScore(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 40) / 100; // 0.00–0.39
}

function tokens(s) {
  return new Set(
    String(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

/** Glossary check shared by the mock judge and mock compare. */
function rejectedTermHits(source, candidate, glossary) {
  const notes = [];
  for (const e of glossary?.entries ?? []) {
    const relevant =
      source.toLowerCase().includes(e.source.toLowerCase()) ||
      candidate.toLowerCase().includes(e.practitionerTerm.toLowerCase());
    if (!relevant) continue;
    for (const r of e.rejected) {
      if (candidate.includes(r.term)) notes.push(`rejected term "${r.term}": ${r.why}`);
    }
  }
  return notes;
}

/**
 * Score meaning from source vs back-translation token overlap.
 * The mock judge flags glossary violations; the pipeline applies the
 * meaning threshold.
 */
export function mockJudgeOne({ key, source, candidate, backtranslation, glossary }) {
  const src = tokens(source);
  const bt = tokens(backtranslation);
  let overlap = 0;
  for (const t of src) if (bt.has(t)) overlap++;
  const base = src.size === 0 ? 0.5 : Math.min(1, overlap / src.size);
  const meaning = Math.round((0.55 + base * 0.4 + hashScore(key) * 0.05) * 100) / 100;
  const glossaryNotes = rejectedTermHits(source, candidate, glossary);
  const glossaryOk = glossaryNotes.length === 0;
  return {
    key,
    meaning,
    fluency: Math.min(1, Math.round((meaning + 0.1) * 100) / 100),
    glossaryOk,
    glossaryNotes,
    escalate: !glossaryOk,
    rationale: glossaryOk
      ? `Mock judge: back-translation overlap ${Math.round(base * 100)}%.`
      : `Mock judge: glossary violation (${glossaryNotes.join("; ")}).`,
  };
}

function compareOne(variant, { key, source, options }, locale, glossary) {
  const labels = Object.keys(options).sort();
  const clean = labels.filter((l) => rejectedTermHits(source, options[l], glossary).length === 0);
  if (variant === "mock:third") {
    // Prefers the shortest acceptable wording.
    const pick = clean.sort((a, b) => options[a].length - options[b].length || a.localeCompare(b))[0];
    return { key, pick: pick ?? "none", rationale: "Mock compare: shortest option without rejected terms." };
  }
  const reference = translateOne("mock:alt", source, locale);
  const pick = clean.find((l) => options[l] === reference);
  return {
    key,
    pick: pick ?? "none",
    rationale: pick
      ? "Mock compare: matches the approved reference wording."
      : "Mock compare: no option matches the reference wording.",
  };
}

/** Create a mock adapter for one variant. */
export function createMockAdapter(variant = "mock") {
  if (!MOCK_VARIANTS.includes(variant)) {
    throw new Error(`Unknown mock variant "${variant}". Known: ${MOCK_VARIANTS.join(", ")}`);
  }
  return {
    id: variant,
    family: "mock",
    describe(stage) {
      return { provider: variant, model: variant, family: "mock", promptVersion: `mock/${stage}@2` };
    },
    batchSize() {
      return 50;
    },
    async translate(batch) {
      return perItem(batch.items, async ({ key, source }) => ({
        key,
        candidate: translateOne(variant, source, batch.locale),
      }));
    },
    async backtranslate(batch) {
      return perItem(batch.items, async ({ key, candidate }) => ({
        key,
        backtranslation: backtranslateOne(candidate, batch.locale),
      }));
    },
    async judge(batch) {
      return perItem(batch.items, async (item) => mockJudgeOne({ ...item, glossary: batch.glossary }));
    },
    async compare(batch) {
      return perItem(batch.items, async (item) => compareOne(variant, item, batch.locale, batch.glossary));
    },
  };
}

/** Text-level helpers (used by the fake CLIs in test/fixtures). */
export function mockTranslateText(variant, text, locale) {
  return translateOne(variant, text, locale);
}

export function mockBacktranslateText(text, locale) {
  return backtranslateOne(text, locale);
}

export function mockCompareOne(variant, item, locale, glossary) {
  return compareOne(variant, item, locale, glossary);
}
