/**
 * Resolve provider specs and profiles into adapters.
 *
 * Provider ids:
 *   mock | mock:alt | mock:third            deterministic, offline
 *   cli:claude | cli:grok | cli:codex       local terminal CLIs (Fleet)
 *   openrouter                              stage default from config/models.json
 *   openrouter:<vendor>/<model>             any OpenRouter model slug
 *   api:jev (alias jev)                     judge / compare only
 *
 * A --provider spec is one of:
 *   a profile name        fleet | openrouter | mock   (see config/profiles.json)
 *   a single provider     cli:grok, openrouter:<slug>  (used for all three stages)
 *   a stage map           translate=…,backtranslate=…,judge=…  (all three required)
 */

import { loadModelsConfig, loadProfilesConfig, resolveProfile, expandStageSpec } from "../config.mjs";
import { createMockAdapter, MOCK_VARIANTS } from "./mock.mjs";
import { createClaudeAdapter } from "./cli-claude.mjs";
import { createGrokAdapter } from "./cli-grok.mjs";
import { createCodexAdapter } from "./cli-codex.mjs";
import { createOpenRouterAdapter } from "./openrouter.mjs";
import { createJevAdapter } from "./jev-openrouter.mjs";
import { UnsupportedStageError } from "./contract.mjs";
import { UsageError } from "../errors.mjs";

export const CORE_STAGES = Object.freeze(["translate", "backtranslate", "judge"]);

const JUDGE_ONLY = new Set(["api:jev", "jev"]);

/** Stages each provider id can run (static check before any call). */
export function supportedStages(spec) {
  if (JUDGE_ONLY.has(spec)) return ["judge", "compare"];
  return ["translate", "backtranslate", "judge", "compare"];
}

/**
 * Parse a --provider spec into { translate, backtranslate, judge }.
 * @param {string} spec
 * @param {{ models?: object }} [opts]
 */
export function parseProviderSpec(spec, { models = loadModelsConfig() } = {}) {
  const s = String(spec || "mock").trim();
  const profiles = loadProfilesConfig().profiles;

  if (!s.includes("=")) {
    if (profiles[s]) return { ...resolveProfile(s, models).stages };
    if (s === "api" || s === "api:mid" || s.startsWith("api:anthropic") || s.startsWith("api:xai") || s.startsWith("api:openai")) {
      throw new UsageError(
        `Provider "${s}" was removed. Use --profile=openrouter (one OPENROUTER_API_KEY), --profile=fleet (local CLIs), or --profile=mock.`,
      );
    }
    if (s.includes(",")) throw new UsageError(`Provider spec "${s}" looks like a stage map but has no "=".`);
    const id = expandStageSpec(s, "translate", models);
    if (!isKnownProvider(id)) {
      throw new UsageError(
        `Unknown provider "${s}". Use a profile (${Object.keys(profiles).join(" | ")}), cli:claude | cli:grok | cli:codex, openrouter:<slug>, or a stage map translate=…,backtranslate=…,judge=….`,
      );
    }
    if (JUDGE_ONLY.has(id)) {
      throw new UsageError(`${id} is judge-only; use it in a stage map, e.g. translate=cli:claude,backtranslate=cli:grok,judge=${id}`);
    }
    return { translate: id, backtranslate: id, judge: id };
  }

  // Stage map: require ALL three stages — no silent fallback.
  const out = {};
  for (const part of s.split(",")) {
    const pieces = part.split("=");
    if (pieces.length > 2) throw new UsageError(`Malformed provider stage "${part.trim()}"`);
    const [k, v] = pieces.map((x) => x.trim());
    if (!k || !v) continue;
    if (!CORE_STAGES.includes(k)) throw new UsageError(`Unknown provider stage "${k}"`);
    if (out[k]) throw new UsageError(`Duplicate provider stage "${k}"`);
    out[k] = expandStageSpec(v, k, models);
    if (!isKnownProvider(out[k])) throw new UsageError(`Unknown provider "${v}" for stage ${k}`);
  }
  for (const stage of CORE_STAGES) {
    if (!out[stage]) {
      throw new UsageError(
        `Provider stage map missing "${stage}". Specify all three stages (translate, backtranslate, judge) or use a profile.`,
      );
    }
  }
  return out;
}

export function isKnownProvider(id) {
  return (
    MOCK_VARIANTS.includes(id) ||
    id === "cli:claude" ||
    id === "cli:grok" ||
    id === "cli:codex" ||
    JUDGE_ONLY.has(id) ||
    /^openrouter:~?[\w.-]+\/[\w.:~-]+$/.test(id)
  );
}

/**
 * Build an adapter for one provider id.
 * @param {string} id
 * @param {{ models?: object, fetchImpl?: typeof fetch, sleep?: Function }} [opts]
 */
export function createAdapter(id, opts = {}) {
  if (MOCK_VARIANTS.includes(id)) return createMockAdapter(id);
  if (id === "cli:claude") return createClaudeAdapter({ models: opts.models });
  if (id === "cli:grok") return createGrokAdapter({ models: opts.models });
  if (id === "cli:codex") return createCodexAdapter({ models: opts.models });
  if (JUDGE_ONLY.has(id)) return createJevAdapter({ models: opts.models, fetchImpl: opts.fetchImpl });
  if (id.startsWith("openrouter:")) {
    return createOpenRouterAdapter(id.slice("openrouter:".length), {
      models: opts.models,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
    });
  }
  throw new Error(`No adapter for provider "${id}"`);
}

/**
 * Adapters for the three core stages, with a static stage-support check.
 * @param {{ translate: string, backtranslate: string, judge: string }} providers
 */
export function resolveAdapters(providers, opts = {}) {
  const out = {};
  for (const stage of CORE_STAGES) {
    const id = providers[stage];
    if (!supportedStages(id).includes(stage)) {
      const err = new UnsupportedStageError(id, stage, "use it only as judge (or blind-audit judge)");
      err.exitCode = 2; // a configuration mistake, not a runtime failure
      throw err;
    }
    out[stage] = createAdapter(id, opts);
  }
  return out;
}

/**
 * Decide which providers a run uses.
 * Precedence: --mock > --provider > --profile > COUNCIL_PROFILE > COUNCIL_PROVIDER > profiles.json default.
 * @returns {{ profile: string, providers: object, faceoff: string[], auditJudges: string[], source: string }}
 */
export function resolveRunProviders({ mock = false, provider, profile, env = process.env, models = loadModelsConfig() } = {}) {
  const cfg = loadProfilesConfig();
  let profileName = null;
  let spec = null;
  let source;
  if (mock) {
    profileName = "mock";
    source = "--mock";
  } else if (provider) {
    spec = provider;
    source = "--provider";
    if (cfg.profiles[provider]) profileName = provider;
  } else if (profile) {
    profileName = profile;
    source = "--profile";
  } else if (env.COUNCIL_PROFILE) {
    profileName = env.COUNCIL_PROFILE;
    source = "COUNCIL_PROFILE";
  } else if (env.COUNCIL_PROVIDER) {
    spec = env.COUNCIL_PROVIDER;
    source = "COUNCIL_PROVIDER";
    if (cfg.profiles[spec]) profileName = spec;
  } else {
    profileName = cfg.default;
    source = "default";
  }

  if (profileName) {
    const p = resolveProfile(profileName, models);
    return { profile: profileName, providers: { ...p.stages }, faceoff: p.faceoff, auditJudges: p.auditJudges, source };
  }

  // Custom spec: faceoff/audit panels default to the distinct providers in the map.
  const providers = parseProviderSpec(spec, { models });
  const panel = [...new Set(CORE_STAGES.map((s) => providers[s]))];
  return {
    profile: "custom",
    providers,
    faceoff: panel.filter((p) => supportedStages(p).includes("translate")),
    auditJudges: panel,
    source,
  };
}
