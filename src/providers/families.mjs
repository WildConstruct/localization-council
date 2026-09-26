/**
 * Model families and the vendor-diversity check.
 *
 * Blind back-translation only works as a check when the back-translator is
 * not the model that produced the candidate: a model tends to "recognize"
 * its own phrasing and round-trip it cleanly. The same goes for a judge
 * grading its own translation or its own back-translation.
 */

const OPENROUTER_VENDOR_FAMILY = {
  anthropic: "anthropic",
  "x-ai": "xai",
  openai: "openai",
  google: "google",
  "meta-llama": "meta",
  mistralai: "mistral",
  deepseek: "deepseek",
  qwen: "qwen",
  cohere: "cohere",
  typesafe: "typesafe",
  amazon: "amazon",
  microsoft: "microsoft",
  nvidia: "nvidia",
  moonshotai: "moonshot",
  "z-ai": "zhipu",
};

const CLI_FAMILY = {
  "cli:claude": "anthropic",
  "cli:grok": "xai",
  "cli:codex": "openai",
};

/** Family for a provider spec (e.g. cli:grok → xai, openrouter:anthropic/x → anthropic). */
export function familyOf(spec) {
  const s = String(spec || "");
  if (s === "mock" || s.startsWith("mock:")) return "mock";
  if (CLI_FAMILY[s]) return CLI_FAMILY[s];
  if (s === "api:jev" || s === "jev") return "typesafe";
  if (s.startsWith("openrouter:")) {
    const slug = s.slice("openrouter:".length).replace(/^~/, "");
    const vendor = slug.split("/")[0];
    return OPENROUTER_VENDOR_FAMILY[vendor] || vendor || "unknown";
  }
  return "unknown";
}

const PAIRS = [
  {
    a: "translate",
    b: "backtranslate",
    code: "same_family_translate_backtranslate",
    why: "blind back-translation is weaker when the same model family wrote the candidate",
  },
  {
    a: "translate",
    b: "judge",
    code: "same_family_judge_translate",
    why: "the judge is grading its own family's translation",
  },
  {
    a: "backtranslate",
    b: "judge",
    code: "same_family_judge_backtranslate",
    why: "the judge is scoring a round-trip its own family produced",
  },
];

/**
 * Warn when stages share a model family. Mock providers are exempt.
 * @param {{ translate: string, backtranslate: string, judge: string }} providers
 * @returns {{ code: string, message: string, stages: string[], family: string }[]}
 */
export function diversityWarnings(providers) {
  const warnings = [];
  for (const { a, b, code, why } of PAIRS) {
    const fa = familyOf(providers[a]);
    const fb = familyOf(providers[b]);
    if (fa === "mock" || fb === "mock" || fa === "unknown") continue;
    if (fa === fb) {
      warnings.push({
        code,
        message: `${a} (${providers[a]}) and ${b} (${providers[b]}) are both ${fa}: ${why}.`,
        stages: [a, b],
        family: fa,
      });
    }
  }
  return warnings;
}
