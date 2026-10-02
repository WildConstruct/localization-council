#!/usr/bin/env node
/**
 * Localization Council MCP server (stdio, zero dependencies).
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. Only protocol messages go to stdout;
 * diagnostics go to stderr. Every tool returns the same machine summary as the matching
 * `council … --json` command (schemas/summary.v1.json), as JSON text and as `structuredContent`.
 */

import { createInterface } from "node:readline";
import { readFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCouncil, diffCatalogs, ARTIFACTS } from "./index.mjs";
import { runDoctor } from "./doctor.mjs";
import { runGlossaryHarvest } from "./glossary-growth.mjs";
import { loadModelsConfig, loadProfilesConfig, resolveProfile, councilVersion } from "./config.mjs";
import { envelope, errorSummary, EXIT, UsageError } from "./summary.mjs";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2025-06-18";
export const PRECEDENCE = "config/models.json < modelsFile < preset < per-stage model";
const INSTRUCTIONS =
  "Localization Council translates UI strings, back-translates them blind with a different model, " +
  "judges meaning and glossary compliance, and escalates doubtful rows to a person. It never merges " +
  "into a product catalog. Start with council_doctor or council_list_presets, use council_diff to see " +
  "the delta, then council_run. status 'escalations' (exitCode 10) is a normal outcome: hand " +
  "artifacts.escalate and artifacts.report to a person. Runs can take minutes. council_glossary_harvest " +
  "proposes glossary entries from shipped strings; a person decides them and applies them with " +
  "`council glossary apply`. Never decide or apply proposals yourself.";

const str = (description) => ({ type: "string", description });
const bool = (description) => ({ type: "boolean", description });
const num = (description) => ({ type: "number", description });
const strList = (description) => ({ type: "array", items: { type: "string" }, description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: "council_list_presets",
    title: "List model presets",
    description: "List the default OpenRouter stage models, every named preset, and the execution profiles.",
    inputSchema: obj({ modelsFile: str("Optional models override JSON (same as --models).") }),
    annotations: READ_ONLY,
  },
  {
    name: "council_doctor",
    title: "Preflight",
    description: "Report which profiles are runnable (keys, Node). Never probes CLIs from MCP; set online to check OpenRouter model slugs.",
    inputSchema: obj({
      online: bool("Check the configured OpenRouter model slugs against the live model list."),
      profile: str("Profile that must be runnable (fleet | openrouter | mock); failing makes status 'error'."),
      preset: str("OpenRouter preset whose slugs to check."),
      modelsFile: str("Optional models override JSON."),
    }),
    annotations: { ...READ_ONLY, openWorldHint: true },
  },
  {
    name: "council_diff",
    title: "Catalog delta",
    description: "Find keys missing from or untranslated in a target catalog. Same summary as `council diff --json`.",
    inputSchema: obj({ source: str("Source (English) catalog JSON path."), target: str("Target locale catalog JSON path.") }, ["source", "target"]),
    annotations: READ_ONLY,
  },
  {
    name: "council_run",
    title: "Run the council",
    description:
      "Translate, blind back-translate, judge, and escalate. Same semantics and summary as `council run --json`; " +
      "artifacts holds absolute paths to candidates, backtranslations, scores, accepted, escalate, report, manifest, and run log. " +
      "Passing preset or a per-stage model selects the openrouter profile unless profile/provider is set. Sends run.log lines as progress notifications when a progressToken is given.",
    inputSchema: obj(
      {
        catalog: str("Source catalog JSON path."),
        locale: str("Target locale tag, e.g. tr, ar, he."),
        target: str("Existing target catalog; only missing or untranslated keys run."),
        keys: strList("Explicit keys to run (same as --keys a,b,c)."),
        glossary: str("Glossary JSON path."),
        out: str("Output directory (default scores/<locale>)."),
        profile: str("Execution profile: fleet | openrouter | mock."),
        provider: str("Advanced provider spec or stage map, e.g. translate=openrouter:<slug>,backtranslate=…,judge=…"),
        preset: str("OpenRouter model preset (see council_list_presets)."),
        translateModel: str("OpenRouter slug for the translate stage."),
        backtranslateModel: str("OpenRouter slug for the back-translate stage."),
        judgeModel: str("OpenRouter slug for the judge stage."),
        meaningThreshold: num("Judge meaning threshold, 0–1 (default 0.75)."),
        faceoff: bool("Run the candidate faceoff on escalations."),
        faceoffProviders: strList("Faceoff translator panel (provider specs)."),
        consensusCull: bool("Accept identical near-tie candidates (implies faceoff)."),
        blindAudit: bool("Blind-audit remaining near ties (implies faceoff)."),
        auditJudges: strList("Blind-audit judge panel (provider specs)."),
        seed: { type: "integer", description: "Blind-audit shuffle seed." },
        noCache: bool("Disable the result cache."),
        modelsFile: str("Optional models override JSON."),
        strictDiversity: bool("Fail instead of warn when stages share a model family."),
      },
      ["catalog", "locale"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "council_glossary_harvest",
    title: "Propose glossary entries",
    description:
      "Find recurring product or domain terms in shipped strings that the glossary doesn't cover yet, and how the " +
      "translations render them. Same summary as `council glossary harvest --json`: status 'proposals' (exitCode 10) " +
      "means artifacts.report and artifacts.proposals go to a person, who decides each one and runs `council glossary " +
      "apply`. Never fill in decisions or apply them yourself. Writes only under out; never edits the glossary.",
    inputSchema: obj(
      {
        catalog: str("English source catalog JSON path."),
        localeFile: str("Shipped locale catalog JSON path."),
        locale: str("Locale tag of localeFile, e.g. de."),
        glossary: str("The product's glossary JSON path (proposals skip terms it already has or declined)."),
        accepted: str("A run's accepted.json, for strings accepted into output but not merged yet."),
        out: str("Output directory (default scores/<locale>-glossary). A re-harvest into the same directory keeps a person's decisions."),
        profile: str("Execution profile: fleet | openrouter | mock."),
        provider: str("Advanced provider spec or stage map."),
        extractor: str("Provider that extracts terms (default: the profile's judge)."),
        minKeys: { type: "integer", description: "Propose a term once it appears in this many keys (default 2)." },
        noCache: bool("Disable the result cache."),
        modelsFile: str("Optional models override JSON."),
      },
      ["catalog", "localeFile", "locale"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "council_status",
    title: "Read a run directory",
    description: "Summarize an existing run output directory (manifest, accepted, escalations) and list the artifact paths that exist. Read-only.",
    inputSchema: obj({ out: str("Run output directory.") }, ["out"]),
    annotations: READ_ONLY,
  },
];

const COMMAND_OF = {
  council_list_presets: "presets",
  council_doctor: "doctor",
  council_diff: "diff",
  council_run: "run",
  council_status: "run",
  council_glossary_harvest: "glossary",
};

function validateArguments(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new UsageError(`${tool.name} arguments must be an object`);
  const { properties, required } = tool.inputSchema;
  for (const key of required) {
    if (args[key] == null || args[key] === "") throw new UsageError(`${tool.name} requires ${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec) throw new UsageError(`Unknown argument "${key}" for ${tool.name}`);
    if (value == null) continue;
    const ok =
      spec.type === "array" ? Array.isArray(value) && value.every((v) => typeof v === "string")
      : spec.type === "integer" ? Number.isInteger(value)
      : typeof value === spec.type;
    if (!ok) throw new UsageError(`${tool.name}: ${key} must be ${spec.type === "array" ? "an array of strings" : `a ${spec.type}`}`);
  }
}

/** The tool result: summary as JSON text plus structuredContent; isError only for status "error". */
export function toolResult(summary) {
  const result = { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], structuredContent: summary };
  if (summary.status === "error") result.isError = true;
  return result;
}

function presetsSummary(args, at) {
  const models = loadModelsConfig({ modelsFile: at(args.modelsFile) });
  const presets = Object.entries(models.openrouter.presets || {}).map(([name, p]) => ({
    name,
    description: p.description || "",
    stages: p.stages,
    faceoff: p.faceoff || [],
    auditJudges: p.auditJudges || [],
  }));
  const profiles = Object.keys(loadProfilesConfig().profiles).map((name) => {
    const p = resolveProfile(name, models);
    return { name, description: p.description, stages: p.stages, faceoff: p.faceoff, auditJudges: p.auditJudges };
  });
  return envelope("presets", { status: "ok", exitCode: EXIT.CLEAN, defaultStages: models.openrouter.stages, presets, profiles, precedence: PRECEDENCE });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

const STAGES = ["translate", "backtranslate", "judge"];
const stageMap = (obj, pick) => Object.fromEntries(STAGES.map((s) => [s, pick(obj[s])]));

async function statusSummary(args, at) {
  const outDir = at(args.out);
  const manifest = await readJson(join(outDir, ARTIFACTS.manifest));
  if (!manifest) return errorSummary("run", new Error(`No readable manifest.json in ${outDir}`));
  const escalate = (await readJson(join(outDir, ARTIFACTS.escalate))) || { count: 0, items: [] };
  const accepted = await readJson(join(outDir, ARTIFACTS.accepted));
  const artifacts = {};
  for (const [key, name] of Object.entries(ARTIFACTS)) {
    const p = join(outDir, name);
    if (await access(p).then(() => true, () => false)) artifacts[key] = p;
  }
  const items = Array.isArray(escalate.items) ? escalate.items : [];
  const escalated = escalate.count ?? items.length;
  const counts = {
    ...(manifest.counts || {}),
    accepted: manifest.counts?.accepted ?? Object.keys(accepted?.strings || {}).length,
    escalated,
  };
  return envelope("run", {
    status: escalated ? "escalations" : "clean",
    exitCode: escalated ? EXIT.ATTENTION : EXIT.CLEAN,
    locale: manifest.locale ?? null,
    profile: manifest.profile ?? null,
    preset: manifest.preset ?? null,
    providers: manifest.providers ?? null,
    models: manifest.models ? stageMap(manifest.models, (m) => m?.requested ?? null) : null,
    outDir,
    artifacts,
    counts,
    escalations: items.map(({ key, reasons }) => ({ key, reasons })),
    costUsd: manifest.cost?.usd ?? null,
    skipped: false,
  });
}

/** Provenance for manifest.json: which MCP tool and arguments produced the run (values, never env). */
function mcpArgv(args, tool = "council_run") {
  const argv = ["mcp", tool];
  for (const [key, value] of Object.entries(args)) {
    if (value == null || value === false) continue;
    if (value === true) argv.push(`--${key}`);
    else argv.push(`--${key}`, Array.isArray(value) ? value.join(",") : String(value));
  }
  return argv;
}

function runOptions(args, { at, env, onLog }) {
  const stageModels = { translate: args.translateModel, backtranslate: args.backtranslateModel, judge: args.judgeModel };
  // Same rule as the CLI: a preset or per-stage model implies the openrouter profile unless the
  // caller (or the environment) chose a profile/provider explicitly.
  const selected = Boolean(args.preset) || Object.values(stageModels).some(Boolean);
  const explicit = args.profile || args.provider || env.COUNCIL_PROFILE || env.COUNCIL_PROVIDER;
  return {
    catalog: at(args.catalog),
    locale: args.locale,
    target: at(args.target),
    keys: args.keys,
    glossary: at(args.glossary),
    out: at(args.out),
    provider: args.provider,
    profile: selected && !explicit ? "openrouter" : args.profile,
    preset: args.preset || env.COUNCIL_PRESET || null,
    presetSource: args.preset ? "flag" : env.COUNCIL_PRESET ? "env" : null,
    stageModels,
    meaningThreshold: args.meaningThreshold,
    faceoff: Boolean(args.faceoff),
    faceoffProviders: args.faceoffProviders,
    consensusCull: Boolean(args.consensusCull),
    blindAudit: Boolean(args.blindAudit),
    auditJudges: args.auditJudges,
    seed: args.seed,
    cache: !args.noCache,
    modelsFile: at(args.modelsFile),
    strictDiversity: Boolean(args.strictDiversity),
    argv: mcpArgv(args),
    onLog,
  };
}

/**
 * @param {{ stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream,
 *   env?: Record<string,string|undefined>, cwd?: string, run?: typeof runCouncil }} [opts]
 */
export function createServer({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env, cwd, run = runCouncil } = {}) {
  // Relative paths resolve against COUNCIL_MCP_ROOT, then Claude Code's project dir, then cwd.
  const root = resolve(cwd || env.COUNCIL_MCP_ROOT || env.CLAUDE_PROJECT_DIR || process.cwd());
  const at = (p) => (p == null || p === "" ? undefined : resolve(root, p));

  let writes = Promise.resolve();
  const send = (message) => {
    const line = `${JSON.stringify(message)}\n`;
    writes = writes
      .then(() => new Promise((done) => stdout.write(line, () => done())))
      .catch((e) => stderr.write(`council-mcp: write failed: ${e.message}\n`));
    return writes;
  };

  async function callTool(name, args, meta) {
    const tool = TOOLS.find((t) => t.name === name);
    try {
      if (!tool) throw new UsageError(`Unknown tool "${name}"`);
      validateArguments(tool, args);
      if (name === "council_list_presets") return toolResult(presetsSummary(args, at));
      if (name === "council_status") return toolResult(await statusSummary(args, at));
      if (name === "council_doctor") {
        const preset = args.preset || env.COUNCIL_PRESET || null;
        const presetSource = args.preset ? "flag" : env.COUNCIL_PRESET ? "env" : null;
        return toolResult(await runDoctor({ online: Boolean(args.online), probe: false, profile: args.profile || null, preset, presetSource, modelsFile: at(args.modelsFile) }));
      }
      if (name === "council_diff") {
        const d = await diffCatalogs(at(args.source), at(args.target));
        const delta = d.missing.length + d.untranslated.length;
        return toolResult(envelope("diff", { status: delta ? "delta" : "clean", exitCode: EXIT.CLEAN, delta, ...d }));
      }
      if (name === "council_glossary_harvest") {
        return toolResult(
          await runGlossaryHarvest({
            catalog: at(args.catalog),
            localeFile: at(args.localeFile),
            locale: args.locale,
            glossary: at(args.glossary),
            accepted: at(args.accepted),
            out: at(args.out),
            profile: args.profile,
            provider: args.provider,
            extractor: args.extractor,
            minKeys: args.minKeys,
            preset: env.COUNCIL_PRESET || null,
            presetSource: env.COUNCIL_PRESET ? "env" : null,
            cache: !args.noCache,
            modelsFile: at(args.modelsFile),
            argv: mcpArgv(args, "council_glossary_harvest"),
          }),
        );
      }
      // council_run
      const token = meta?.progressToken;
      let progress = 0;
      const onLog = token == null ? undefined : (line) => send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++progress, message: line } });
      return toolResult(await run(runOptions(args, { at, env, onLog })));
    } catch (e) {
      if (!(e instanceof UsageError)) stderr.write(`council-mcp: ${name}: ${e?.stack || e}\n`);
      const summary = errorSummary(COMMAND_OF[name] || "run", e);
      if (name === "council_glossary_harvest") summary.action = "harvest";
      return toolResult(summary);
    }
  }

  /** Returns the JSON-RPC result for a request; throws { rpcCode } for protocol errors. */
  async function handleRequest(msg) {
    const params = msg.params || {};
    switch (msg.method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false }, logging: {} },
          serverInfo: { name: "localization-council", title: "Localization Council", version: councilVersion() },
          instructions: INSTRUCTIONS,
        };
      case "ping":
      case "logging/setLevel":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return callTool(params.name, params.arguments ?? {}, params._meta);
      default:
        throw Object.assign(new Error(`Method not found: ${msg.method}`), { rpcCode: -32601 });
    }
  }

  /** Handle one parsed message; resolves to the response object, or null for notifications. */
  async function handleMessage(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") {
      const id = msg && typeof msg === "object" && "id" in msg ? msg.id : null;
      // A response from the client (we never send requests) or garbage: only reply when it had an id.
      if (msg && typeof msg === "object" && ("result" in msg || "error" in msg)) return null;
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
    }
    if (!("id" in msg)) return null; // notifications (initialized, cancelled, …) never get replies
    try {
      return { jsonrpc: "2.0", id: msg.id, result: await handleRequest(msg) };
    } catch (e) {
      return { jsonrpc: "2.0", id: msg.id, error: { code: e.rpcCode || -32603, message: String(e.message || e) } };
    }
  }

  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    // Requests run concurrently: a long council_run never blocks ping or tools/list.
    handleMessage(msg).then((reply) => reply && send(reply));
  });

  return { handleMessage, close: () => rl.close(), flush: () => writes };
}

export function main() {
  const server = createServer();
  process.stdin.on("end", () => server.flush().then(() => process.exit(0)));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
