/**
 * `council doctor`: what can this machine run?
 *
 * Reports installed CLIs (version, minimum from config/models.json,
 * best-effort auth state), which keys are present (never their values), and
 * which profiles are runnable. Emits one JSON object with --json so an agent
 * can pick a profile automatically.
 *
 * Auth detection is heuristic (config files / env vars) because the CLIs have
 * no shared noninteractive auth-status command. `--probe` confirms with one
 * tiny live call per CLI (costs a few tokens).
 */

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadModelsConfig, applyModelSelection, loadProfilesConfig, resolveProfile } from "./config.mjs";
import { whichBin, cliVersion, compareVersions, runCli, isolatedCwd } from "./providers/cli-spawn.mjs";
import { resolveOpenRouterApiKey, checkOpenRouterModels } from "./providers/openrouter.mjs";
import { envelope, EXIT, UsageError } from "./summary.mjs";

const CLI_NAMES = ["claude", "grok", "codex"];

async function exists(p) {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort auth state without spending tokens. */
async function authState(name, env = process.env) {
  const home = homedir();
  if (name === "claude") {
    if (env.ANTHROPIC_API_KEY) return { state: "api_key", detail: "ANTHROPIC_API_KEY is set" };
    const dir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
    if (await exists(join(dir, ".credentials.json"))) return { state: "logged_in", detail: `${dir}/.credentials.json` };
    return { state: "unknown", detail: "no credentials file found (macOS keychain logins cannot be detected; use --probe)" };
  }
  if (name === "codex") {
    const dir = env.CODEX_HOME || join(home, ".codex");
    if (await exists(join(dir, "auth.json"))) return { state: "logged_in", detail: `${dir}/auth.json` };
    if (env.OPENAI_API_KEY) return { state: "api_key", detail: "OPENAI_API_KEY is set" };
    return { state: "unknown", detail: "no ~/.codex/auth.json found (use --probe)" };
  }
  if (name === "grok") {
    if (env.GROK_API_KEY || env.XAI_API_KEY) return { state: "api_key", detail: "GROK_API_KEY/XAI_API_KEY is set" };
    if (await exists(join(home, ".grok"))) return { state: "configured", detail: "~/.grok exists" };
    return { state: "unknown", detail: "no grok config found (use --probe)" };
  }
  return { state: "unknown", detail: "" };
}

async function probe(name, bin) {
  const args =
    name === "claude"
      ? ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--permission-prompts", "none"]
      : name === "codex"
        ? ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-"]
        : ["-p", "Reply with exactly: OK", "--output-format", "json"];
  const input = name === "grok" ? undefined : "Reply with exactly: OK";
  try {
    await runCli(bin, args, { input, timeoutMs: 120_000, cwd: isolatedCwd() });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message).split("\n")[0].slice(0, 300) };
  }
}

/** Inspect one CLI. */
export async function inspectCli(name, { models = loadModelsConfig(), doProbe = false } = {}) {
  const cfg = models.cli[name];
  const binName = process.env[cfg.binEnv] || cfg.bin;
  const out = {
    name,
    installed: false,
    path: null,
    version: null,
    minVersion: cfg.minVersion ?? null,
    versionOk: null,
    auth: null,
  };
  try {
    out.path = await whichBin(binName);
    out.installed = true;
  } catch {
    return out;
  }
  const v = await cliVersion(out.path);
  out.version = v.version;
  out.versionRaw = v.raw;
  if (out.minVersion && out.version) out.versionOk = compareVersions(out.version, out.minVersion) >= 0;
  out.auth = await authState(name);
  if (doProbe) {
    const p = await probe(name, out.path);
    out.auth = p.ok
      ? { state: "verified", detail: "live probe succeeded" }
      : { state: "failed", detail: p.error };
  }
  return out;
}

/** Versions for the manifest: node + any CLI a run used. */
export async function toolVersions(providerIds, models = loadModelsConfig()) {
  const cli = {};
  for (const id of providerIds) {
    if (!id.startsWith("cli:")) continue;
    const name = id.slice(4);
    if (cli[name] || !models.cli[name]) continue;
    const info = await inspectCli(name, { models });
    cli[name] = { name, version: info.version, minVersion: info.minVersion, versionOk: info.versionOk, path: info.path };
  }
  return { node: process.version, platform: `${process.platform}-${process.arch}`, cli };
}

function requirementMet(req, { clis, keys }) {
  if (req.startsWith("env:")) return Boolean(keys[req.slice(4)]);
  if (req.startsWith("cli:")) {
    const c = clis[req.slice(4)];
    return Boolean(c?.installed && c.versionOk !== false && !["failed"].includes(c.auth?.state));
  }
  return false;
}

/**
 * @param {{ online?: boolean, probe?: boolean, profile?: string|null, fetchImpl?: typeof fetch, modelsFile?: string }} [opts]
 */
export async function runDoctor(opts = {}) {
  const rawModels = loadModelsConfig({ modelsFile: opts.modelsFile });
  const models = applyModelSelection(rawModels, { preset: opts.preset });
  const profilesCfg = loadProfilesConfig();
  if (opts.profile && !profilesCfg.profiles[opts.profile]) {
    throw new UsageError(`Unknown profile "${opts.profile}". Known: ${Object.keys(profilesCfg.profiles).join(", ")}`);
  }
  if (opts.preset && opts.presetSource !== "env" && opts.profile && opts.profile !== "openrouter") {
    throw new UsageError("--preset/--*-model only affect OpenRouter stages; use --profile=openrouter");
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const clis = {};
  for (const name of CLI_NAMES) clis[name] = await inspectCli(name, { models, doProbe: opts.probe });
  const keys = { OPENROUTER_API_KEY: Boolean(resolveOpenRouterApiKey()) };

  let openrouter = null;
  if (opts.online) {
    const slugs = [
      ...new Set([
        ...Object.values(models.openrouter.stages),
        ...(models.openrouter.faceoff || []),
        ...(models.openrouter.auditJudges || []),
        ...Object.values(rawModels.openrouter.presets || {}).flatMap((p) => [
          ...Object.values(p.stages || {}),
          ...(p.faceoff || []),
          ...(p.auditJudges || []),
        ]),
      ]),
    ];
    openrouter = await checkOpenRouterModels(slugs, { fetchImpl: opts.fetchImpl, models });
  }

  const profiles = {};
  const warnings = [];
  for (const name of Object.keys(profilesCfg.profiles)) {
    const p = resolveProfile(name, models);
    const missing = p.requires.filter((r) => !requirementMet(r, { clis, keys }));
    const info = { runnable: missing.length === 0, missing, stages: p.stages };
    if (name === "openrouter" && openrouter?.reachable) {
      const required = new Set([
        ...Object.values(models.openrouter.stages),
        ...(models.openrouter.faceoff || []),
        ...(models.openrouter.auditJudges || []),
      ]);
      const bad = Object.entries(openrouter.models).filter(([slug, ok]) => required.has(slug) && !ok).map(([s]) => s);
      if (bad.length) {
        info.runnable = false;
        info.missing.push(...bad.map((s) => `model:${s}`));
        warnings.push({
          code: "openrouter_model_not_found",
          message: `OpenRouter does not list ${bad.join(", ")}. Update config/models.json (openrouter.*) or pass a stage map with openrouter:<slug>.`,
        });
      }
    }
    profiles[name] = info;
  }
  for (const c of Object.values(clis)) {
    if (c.installed && c.versionOk === false) {
      warnings.push({ code: "cli_below_min_version", message: `${c.name} ${c.version} < minimum ${c.minVersion} (config/models.json).` });
    }
  }
  if (nodeMajor < 20) warnings.push({ code: "node_too_old", message: `Node ${process.version} < 20 (package.json engines).` });

  const preference = ["fleet", "openrouter", "mock"];
  const recommendedProfile = preference.find((p) => profiles[p]?.runnable) || "mock";

  let status = "ok";
  let exitCode = EXIT.CLEAN;
  if (opts.profile && !profiles[opts.profile].runnable) {
    status = "not_runnable";
    exitCode = EXIT.PREFLIGHT;
  }
  return envelope("doctor", {
    status,
    exitCode,
    node: { version: process.version, ok: nodeMajor >= 20 },
    clis,
    keys,
    openrouter,
    profiles,
    requestedProfile: opts.profile || null,
    recommendedProfile,
    warnings,
  });
}
