/**
 * Shared behavior for the fake claude / codex / grok CLIs used in tests.
 * Parses the adapters' prompts and answers like the mock providers, so the
 * Fleet path can be exercised end to end without real CLIs.
 */
import {
  mockTranslateText,
  mockBacktranslateText,
  mockJudgeOne,
  mockCompareOne,
} from "../../src/providers/mock.mjs";

function field(prompt, labels) {
  const lines = prompt.split("\n");
  for (const label of labels) {
    const line = lines.find((l) => l.startsWith(label));
    if (line != null) return line.slice(label.length).trim();
  }
  return "";
}

/** Rebuild a minimal glossary object from glossaryPromptBlock() text. */
export function parseGlossaryBlock(prompt) {
  const entries = [];
  let cur = null;
  for (const line of prompt.split("\n")) {
    const e = line.match(/^- "(.+?)" → "(.+?)" \[/);
    if (e) {
      cur = { source: e[1], practitionerTerm: e[2], rejected: [] };
      entries.push(cur);
      continue;
    }
    const r = line.match(/^\s+✗ reject "(.+?)": (.*)$/);
    if (r && cur) cur.rejected.push({ term: r[1], why: r[2] });
  }
  return entries.length ? { entries } : null;
}

/** Decide the stage from the prompt text + schema flag. */
export function answer({ prompt, schema, variant }) {
  const locale =
    field(prompt, ["Locale:"]) ||
    prompt.match(/from "?([\w-]+)"? to English/)?.[1] ||
    prompt.match(/locale "([^"]+)"/)?.[1] ||
    prompt.match(/string to ([\w-]+)\./)?.[1] ||
    "de";
  const schemaText = schema || "";
  if (/"pick"/.test(schemaText) || /^Options:/m.test(prompt)) {
    const source = field(prompt, ["English source:"]);
    const options = {};
    for (const m of prompt.matchAll(/^([XYZWVUTSRQ]): (.*)$/gm)) options[m[1]] = m[2];
    return JSON.stringify(mockCompareOne(variant, { key: "", source, options }, locale, parseGlossaryBlock(prompt)));
  }
  if (/"meaning"/.test(schemaText) || /localization judge/i.test(prompt)) {
    const v = mockJudgeOne({
      key: "",
      source: field(prompt, ["Source (EN):", "Source:"]),
      candidate: field(prompt, ["Candidate:"]),
      backtranslation: field(prompt, ["Blind back-translation:", "Backtranslation:"]),
      glossary: parseGlossaryBlock(prompt),
    });
    return JSON.stringify({
      meaning: v.meaning,
      fluency: v.fluency,
      glossaryOk: v.glossaryOk,
      escalate: v.escalate,
      rationale: v.rationale,
    });
  }
  if (/back-translate/i.test(prompt)) {
    const cand = prompt.match(/Candidate(?: \([^)]*\))?:\s*\n?([^\n]+)\s*$/)?.[1]?.trim() ?? "";
    return mockBacktranslateText(cand, locale);
  }
  const src =
    prompt.match(/Translate:\n([\s\S]+)$/)?.[1] ??
    prompt.match(/Source:\n([\s\S]+)$/)?.[1] ??
    field(prompt, ["Source:"]);
  return mockTranslateText(variant, src.trim(), locale);
}
