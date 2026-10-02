/**
 * Load config/models.json and config/profiles.json.
 *
 * config/models.json is the only place model IDs and minimum CLI versions
 * live. Callers may merge an override file on top (--models <file>).
 */

import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "./errors.mjs";

const CONFIG_DIR = new URL("../config/", import.meta.url);
const PKG_URL = new URL("../package.json", import.meta.url);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Folders of this checkout that git ignores, where a team's own data may sit. */
const PRIVATE_DIRS = new Set(["scores", "local"]);

/**
 * A warning when `path` would put a team's own data (a glossary, proposals, the term inventory) in
 * this checkout of localization-council where it could be committed. scores/ and local/ are
 * ignored; anywhere else in the checkout is not. Returns null when the path is fine.
 * @param {string} path
 * @param {string} what - e.g. "--out"
 */
export function councilCheckoutWarning(path, what) {
  if (!path) return null;
  const rel = relative(PACKAGE_ROOT, resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null; // outside the checkout
  if (rel && PRIVATE_DIRS.has(rel.split(sep)[0])) return null;
  return {
    code: "inside_council_checkout",
    message:
      `${what} ${resolve(path)} is inside the localization-council checkout. Keep your glossary and council output ` +
      "in your own repo, or under scores/ or local/ (both ignored by git); never commit them to localization-council.",
  };
}

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge: objects merge key by key, arrays and scalars replace. */
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * Load model config, optionally merged with an override file.
 * @param {{ modelsFile?: string|null }} [opts]
 */
export function loadModelsConfig({ modelsFile = null } = {}) {
  const base = readJson(new URL("models.json", CONFIG_DIR));
  if (!modelsFile) return base;
  const override = JSON.parse(readFileSync(resolve(modelsFile), "utf8"));
  return deepMerge(base, override);
}

export function loadProfilesConfig() {
  return readJson(new URL("profiles.json", CONFIG_DIR));
}

export function presetNames(models = loadModelsConfig()) {
  return Object.keys(models.openrouter?.presets || {});
}

/** Apply a named OpenRouter preset, then optional per-stage slug overrides. */
export function applyModelSelection(models, { preset = null, stageModels = null } = {}) {
  let openrouter = { ...models.openrouter, stages: { ...models.openrouter?.stages } };
  if (preset) {
    const selected = models.openrouter?.presets?.[preset];
    if (!selected) throw new UsageError(`Unknown preset "${preset}". Known: ${presetNames(models).join(", ")}`);
    openrouter = {
      ...openrouter,
      stages: { ...openrouter.stages, ...selected.stages },
      faceoff: selected.faceoff ? selected.faceoff.slice() : openrouter.faceoff,
      auditJudges: selected.auditJudges ? selected.auditJudges.slice() : openrouter.auditJudges,
    };
  }
  for (const [stage, slug] of Object.entries(stageModels || {})) {
    if (slug == null) continue;
    if (!["translate", "backtranslate", "judge"].includes(stage)) {
      throw new UsageError(`Unknown OpenRouter stage model override "${stage}"`);
    }
    if (!/^~?[\w.-]+\/[\w.:~-]+$/.test(String(slug))) {
      throw new UsageError(`Invalid OpenRouter slug "${slug}" for --${stage}-model`);
    }
    openrouter.stages[stage] = String(slug);
  }
  return { ...models, openrouter };
}

export function profileNames() {
  return Object.keys(loadProfilesConfig().profiles);
}

export function councilVersion() {
  return readJson(PKG_URL).version;
}

/**
 * Expand a profile list field. Accepts an array of provider specs, or a
 * dotted pointer into models.json (e.g. "openrouter.faceoff") whose slugs
 * become openrouter:<slug> specs.
 */
export function expandProviderList(value, models) {
  if (Array.isArray(value)) return value.slice();
  if (typeof value === "string" && value.startsWith("openrouter.")) {
    const field = value.slice("openrouter.".length);
    const slugs = models.openrouter?.[field];
    if (!Array.isArray(slugs) || !slugs.length) {
      throw new Error(`config/models.json has no openrouter.${field} list`);
    }
    return slugs.map((s) => `openrouter:${s}`);
  }
  if (typeof value === "string" && value) return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * Resolve a named profile into concrete stage specs.
 * "openrouter" as a stage value becomes openrouter:<stage default slug>.
 * @returns {{ name, description, stages: {translate, backtranslate, judge}, faceoff: string[], auditJudges: string[], requires: string[] }}
 */
export function resolveProfile(name, models = loadModelsConfig()) {
  const cfg = loadProfilesConfig();
  const p = cfg.profiles[name];
  if (!p) {
    throw new UsageError(`Unknown profile "${name}". Known: ${Object.keys(cfg.profiles).join(", ")}`);
  }
  const stages = {};
  for (const stage of ["translate", "backtranslate", "judge"]) {
    stages[stage] = expandStageSpec(p[stage], stage, models);
  }
  return {
    name,
    description: p.description || "",
    stages,
    faceoff: expandProviderList(p.faceoff, models).map((s) => expandStageSpec(s, "translate", models)),
    auditJudges: expandProviderList(p.auditJudges, models).map((s) => expandStageSpec(s, "judge", models)),
    requires: p.requires || [],
  };
}

/** "openrouter" alone → openrouter:<models.openrouter.stages[stage]>. */
export function expandStageSpec(spec, stage, models = loadModelsConfig()) {
  const s = String(spec || "").trim();
  if (s === "openrouter") {
    const slug = models.openrouter?.stages?.[stage === "compare" ? "judge" : stage];
    if (!slug) throw new Error(`config/models.json has no openrouter.stages.${stage}`);
    return `openrouter:${slug}`;
  }
  return s;
}
