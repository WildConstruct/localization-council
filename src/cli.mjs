#!/usr/bin/env node
/**
 * council — Localization Council CLI.
 *
 * Machine contract (see AGENTS.md):
 *   --json   print exactly one summary object (schemas/summary.v1.json) to stdout
 *   exit     0 clean · 10 escalations/reopens · 1 error · 2 usage · 3 preflight failed
 *   quiet    without --json, nothing is printed to stdout when there is nothing to do
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCouncil, diffCatalogs } from "./index.mjs";
import { runGardenDryDiff } from "./garden.mjs";
import { runTidy } from "./tidy.mjs";
import { runDoctor } from "./doctor.mjs";
import { councilVersion, presetNames, profileNames } from "./config.mjs";
import { envelope, errorSummary, EXIT, UsageError } from "./summary.mjs";

const BOOLEAN_FLAGS = new Set([
  "json",
  "verbose",
  "mock",
  "dry-diff",
  "faceoff",
  "consensus-cull",
  "blind-audit",
  "no-cache",
  "strict-diversity",
  "generate-bt",
  "online",
  "probe",
  "help",
]);

const COMMON = ["json", "verbose", "help", "models"];
const PROVIDER_FLAGS = ["profile", "provider", "mock"];
const MODEL_FLAGS = ["preset", "translate-model", "backtranslate-model", "judge-model"];

const COMMAND_FLAGS = {
  run: [
    ...COMMON,
    ...PROVIDER_FLAGS,
    ...MODEL_FLAGS,
    "catalog",
    "locale",
    "glossary",
    "target",
    "out",
    "keys",
    "meaning-threshold",
    "faceoff",
    "faceoff-providers",
    "faceoff-margin",
    "consensus-cull",
    "consensus-min",
    "blind-audit",
    "audit-judges",
    "audit-consensus-min",
    "seed",
    "no-cache",
    "cache-dir",
    "strict-diversity",
  ],
  diff: [...COMMON, "source", "target"],
  garden: [...COMMON, "manifest", "root", "dry-diff", "mode"],
  tidy: [
    ...COMMON,
    ...PROVIDER_FLAGS,
    ...MODEL_FLAGS,
    "catalog",
    "en",
    "locale-file",
    "locale",
    "glossary",
    "bt-file",
    "keys-file",
    "limit",
    "judge",
    "generate-bt",
    "meaning-threshold",
    "out",
    "no-cache",
    "cache-dir",
  ],
  doctor: [...COMMON, "online", "probe", "profile", "preset"],
  help: [...COMMON],
  version: [...COMMON],
};

export function usage() {
  return `council ${councilVersion()} — Localization Council (MIT localization evaluation harness)

Usage:
  council doctor  [--json] [--online] [--probe] [--profile <name>] [--preset <name>]
  council run     --catalog <en.json> --locale <tag> [options]
  council diff    --source <en.json> --target <locale.json> [--json]
  council tidy    --catalog <en.json> --locale-file <locale.json> --locale <tag> [options]
  council garden  --manifest <garden.json> [--root <dir>] [--json]
  council help | version

Profiles (config/profiles.json): ${profileNames().join(" | ")}
  --profile=mock        offline, deterministic (default when nothing is set)
  --profile=openrouter  one OPENROUTER_API_KEY; stage models in config/models.json
  --profile=fleet       local CLIs: claude translate → grok blind BT → codex judge
  --provider <spec>     advanced: cli:grok | openrouter:<slug> | stage map
                        translate=…,backtranslate=…,judge=… (all three required)

Model presets: ${presetNames().join(" | ")}
  --preset <name>             select OpenRouter stage models (or COUNCIL_PRESET)
  --translate-model <slug>    override the OpenRouter translate model
  --backtranslate-model <slug> override the OpenRouter back-translation model
  --judge-model <slug>        override the OpenRouter judge model

run options:
  --glossary <path>           glossary JSON (schemas/glossary.v0.json)
  --target <path>             only keys missing/untranslated in this catalog
  --keys <k1,k2,…>           only these catalog keys
  --out <dir>                 artifacts (default ./scores/<locale>)
  --meaning-threshold <n>     default 0.75
  --faceoff                   extra candidates for escalated keys; clear winners are accepted
    --faceoff-providers a,b     default: the profile's faceoff panel
    --faceoff-margin <n>        lead over the next acceptable candidate (default 0.05)
  --consensus-cull            accept near-ties where ≥ N candidates are identical (implies --faceoff)
    --consensus-min <n>         default 2
  --blind-audit               blind X/Y/Z vote on remaining near-ties (implies --faceoff)
    --audit-judges a,b,c        default: the profile's audit panel
    --audit-consensus-min <n>   default 2
    --seed <int>                shuffle seed (recorded in manifest.json)
  --no-cache | --cache-dir <dir>   result cache (default <out>/.cache; reruns skip finished work)
  --strict-diversity          fail (instead of warn) when stages share a model family
  --models <file>             JSON merged over config/models.json

tidy options:
  --judge <provider>          default: the profile's judge (api:jev uses typed tidy questions)
  --bt-file <path>            back-translations from a prior run (backtranslations.json)
  --generate-bt               back-translate rows missing from --bt-file with the profile's BT provider
  --glossary, --keys-file, --limit, --out (default ./scores/<locale>-tidy), --meaning-threshold

doctor options:
  --online                    check that the configured OpenRouter model slugs exist
  --probe                     one tiny live call per installed CLI to confirm auth
  --profile <name>            exit 3 if that profile is not runnable here

Exit codes: 0 clean · 10 escalations (run) / reopen rows (tidy) · 1 error · 2 usage · 3 preflight failed
Artifacts (run): candidates.json backtranslations.json scores.json escalate.json accepted.json report.md manifest.json
The council accepts into output under --out. A person merges. The council never merges.
`;
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq !== -1 ? a.slice(2, eq) : a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq !== -1) {
        const v = a.slice(eq + 1);
        args[key] = !(v === "false" || v === "0");
      } else {
        args[key] = true;
      }
      continue;
    }
    if (eq !== -1) {
      args[key] = a.slice(eq + 1);
    } else {
      const val = argv[i + 1];
      if (val == null || val.startsWith("--")) throw new UsageError(`Missing value for --${key}`);
      args[key] = val;
      i++;
    }
  }
  return args;
}

function checkFlags(cmd, args) {
  const allowed = new Set(COMMAND_FLAGS[cmd] || []);
  for (const k of Object.keys(args)) {
    if (k === "_") continue;
    if (!allowed.has(k)) throw new UsageError(`Unknown option --${k} for "${cmd}". Try: council help`);
  }
}

function runOptions(args, argv) {
  const selection = modelSelection(args);
  return {
    catalog: args.catalog,
    locale: args.locale,
    glossary: args.glossary,
    target: args.target,
    out: args.out,
    keys: args.keys ? String(args.keys).split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    mock: Boolean(args.mock),
    provider: args.provider,
    profile: selectedProfile(args, selection),
    ...selection,
    meaningThreshold: args["meaning-threshold"],
    faceoff: Boolean(args.faceoff),
    faceoffProviders: args["faceoff-providers"],
    faceoffMargin: args["faceoff-margin"],
    consensusCull: Boolean(args["consensus-cull"]),
    consensusMin: args["consensus-min"],
    blindAudit: Boolean(args["blind-audit"]),
    auditJudges: args["audit-judges"],
    auditConsensusMin: args["audit-consensus-min"],
    seed: args.seed,
    cache: !args["no-cache"],
    cacheDir: args["cache-dir"],
    modelsFile: args.models,
    strictDiversity: Boolean(args["strict-diversity"]),
    argv,
  };
}

function modelSelection(args) {
  return {
    preset: args.preset || process.env.COUNCIL_PRESET || null,
    presetSource: args.preset ? "flag" : process.env.COUNCIL_PRESET ? "env" : null,
    stageModels: {
      translate: args["translate-model"],
      backtranslate: args["backtranslate-model"],
      judge: args["judge-model"],
    },
  };
}

function selectedProfile(args, selection) {
  const selected = args.preset || Object.values(selection.stageModels).some(Boolean);
  const explicit = args.profile || args.provider || args.mock || process.env.COUNCIL_PROFILE || process.env.COUNCIL_PROVIDER;
  return selected && !explicit ? "openrouter" : args.profile;
}

function humanRun(s, out, err, verbose) {
  for (const w of s.warnings) err(`warning: ${w.message}\n`);
  if (s.skipped) {
    if (verbose) out(`${s.locale}: nothing to translate (${s.reason}).\n`);
    return;
  }
  if (s.status === "clean") {
    if (verbose) out(`${s.locale}: ${s.counts.accepted} accepted into output, 0 escalations. ${s.artifacts.report}\n`);
    return;
  }
  out(`${s.locale}: ${s.counts.escalated} escalation(s) for a human (${s.counts.accepted} accepted into output).\n`);
  for (const e of s.escalations) out(`  ${e.key}: ${e.reasons.join("; ")}\n`);
  out(`Report: ${s.artifacts.report}\nSheet:  ${s.artifacts.escalate}\n`);
}

function humanDoctor(s, out) {
  out(`Node ${s.node.version}${s.node.ok ? "" : " (need ≥20)"}\n\nCLIs:\n`);
  for (const c of Object.values(s.clis)) {
    if (!c.installed) {
      out(`  ${c.name.padEnd(7)} not installed\n`);
      continue;
    }
    const ver = `${c.version ?? "?"}${c.minVersion ? ` (min ${c.minVersion}${c.versionOk === false ? ", TOO OLD" : ""})` : ""}`;
    out(`  ${c.name.padEnd(7)} ${ver.padEnd(26)} auth: ${c.auth?.state}\n`);
  }
  out(`\nKeys:\n  OPENROUTER_API_KEY ${s.keys.OPENROUTER_API_KEY ? "set" : "not set"}\n`);
  if (s.openrouter) {
    out(`\nOpenRouter models (${s.openrouter.reachable ? "online" : `unreachable: ${s.openrouter.error}`}):\n`);
    for (const [slug, ok] of Object.entries(s.openrouter.models)) out(`  ${ok ? "ok     " : "MISSING"} ${slug}\n`);
  }
  out("\nProfiles:\n");
  for (const [name, p] of Object.entries(s.profiles)) {
    out(`  ${name.padEnd(11)} ${p.runnable ? "runnable" : `not runnable (missing: ${p.missing.join(", ")})`}\n`);
  }
  out(`\nRecommended: --profile=${s.recommendedProfile}\n`);
}

/**
 * Run the CLI. Returns the exit code (does not call process.exit).
 * @param {string[]} argv
 * @param {{ stdout?: (s:string)=>void, stderr?: (s:string)=>void, fetchImpl?: typeof fetch }} [io]
 */
export async function main(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  let cmd = argv[0] || "help";
  if (cmd === "-h" || cmd === "--help") cmd = "help";
  if (cmd === "-v" || cmd === "--version") cmd = "version";
  let args = { _: [] };
  try {
    args = parseArgs(argv.slice(1));
    if (!COMMAND_FLAGS[cmd]) throw new UsageError(`Unknown command "${cmd}". Try: council help`);
    checkFlags(cmd, args);
    if (args.help) cmd = "help";

    let summary;
    if (cmd === "help") {
      if (args.json || argv.includes("--json")) {
        out(JSON.stringify(envelope("help", { status: "ok", exitCode: EXIT.CLEAN, usage: usage() }), null, 2) + "\n");
      } else {
        out(usage());
      }
      return EXIT.CLEAN;
    }
    if (cmd === "version") {
      if (args.json) out(JSON.stringify(envelope("version", { status: "ok", exitCode: 0, version: councilVersion() })) + "\n");
      else out(`${councilVersion()}\n`);
      return EXIT.CLEAN;
    }

    if (cmd === "diff") {
      if (!args.source || !args.target) throw new UsageError("diff requires --source and --target");
      const d = await diffCatalogs(args.source, args.target);
      const delta = d.missing.length + d.untranslated.length;
      summary = envelope("diff", { status: delta ? "delta" : "clean", exitCode: EXIT.CLEAN, delta, ...d });
      if (!args.json && delta) {
        out(`${delta} key(s) need translation (${d.missing.length} missing, ${d.untranslated.length} identical to source):\n`);
        for (const m of [...d.missing, ...d.untranslated]) out(`  ${m.key} (${m.reason})\n`);
      }
    } else if (cmd === "run") {
      const noteMockFallback = !args.profile && !args.provider && !args.mock && !args.preset && !MODEL_FLAGS.slice(1).some((f) => args[f]) && !process.env.COUNCIL_PRESET && !process.env.COUNCIL_PROFILE && !process.env.COUNCIL_PROVIDER;
      summary = await runCouncil({ ...runOptions(args, argv), fetchImpl: io.fetchImpl });
      if (noteMockFallback && !summary.skipped) {
        err("note: no --profile given; using the offline mock profile. Run `council doctor` to see what this machine can run.\n");
      }
      if (!args.json) humanRun(summary, out, err, args.verbose);
    } else if (cmd === "tidy") {
      const selection = modelSelection(args);
      summary = await runTidy({
        catalog: args.catalog || args.en,
        localeFile: args["locale-file"],
        locale: args.locale,
        glossary: args.glossary,
        btFile: args["bt-file"],
        keysFile: args["keys-file"],
        limit: args.limit,
        judge: args.judge,
        generateBt: Boolean(args["generate-bt"]),
        meaningThreshold: args["meaning-threshold"],
        out: args.out,
        mock: Boolean(args.mock),
        provider: args.provider,
        profile: selectedProfile(args, selection),
        ...selection,
        cache: !args["no-cache"],
        cacheDir: args["cache-dir"],
        modelsFile: args.models,
        fetchImpl: io.fetchImpl,
        argv,
      });
      if (!args.json && summary.exitCode === EXIT.ATTENTION) {
        out(`${summary.locale}: ${summary.counts.reopen} of ${summary.counts.rows} shipped row(s) should reopen. ${summary.artifacts.summary}\n`);
      } else if (!args.json && args.verbose) {
        out(`${summary.locale}: ${summary.counts.rows} row(s) re-audited, none reopen.\n`);
      }
    } else if (cmd === "garden") {
      if (!args.manifest) throw new UsageError("garden requires --manifest");
      const mode = args.mode || "dry-diff";
      if (mode !== "dry-diff") {
        throw new UsageError(`garden mode "${mode}" is not implemented (only --dry-diff).`);
      }
      const g = await runGardenDryDiff({ manifest: args.manifest, root: args.root || process.cwd() });
      summary = envelope("garden", {
        status: g.errors ? "errors" : g.withDelta ? "delta" : "clean",
        exitCode: g.errors ? EXIT.ERROR : EXIT.CLEAN,
        ...g,
        errors: g.results.filter((r) => r.error).map((r) => ({ code: r.status, message: `${r.repo} ${r.id} (${r.locale}): ${r.error}` })),
      });
      if (!args.json && !g.allClean) {
        for (const r of g.results) {
          if (r.status === "CLEAN" || r.status === "deferred_locale") continue;
          out(`${r.status.padEnd(14)} ${r.repo} ${r.id} (${r.locale})${r.delta ? `: ${r.delta} key(s)` : ""}${r.error ? `: ${r.error}` : ""}\n`);
        }
      }
    } else if (cmd === "doctor") {
      const selection = modelSelection(args);
      summary = await runDoctor({
        online: Boolean(args.online),
        probe: Boolean(args.probe),
        profile: selectedProfile(args, selection) || null,
        preset: selection.preset,
        presetSource: selection.presetSource,
        modelsFile: args.models,
        fetchImpl: io.fetchImpl,
      });
      if (!args.json) humanDoctor(summary, out);
    }

    if (args.json) out(JSON.stringify(summary, null, 2) + "\n");
    return summary.exitCode;
  } catch (e) {
    const summary = errorSummary(COMMAND_FLAGS[cmd] ? cmd : "help", e);
    if (summary.command === "help") summary.usage = null;
    err(`error: ${summary.errors[0].message}\n`);
    // Honor --json even when argument parsing itself failed.
    if (args.json || argv.includes("--json")) out(JSON.stringify(summary, null, 2) + "\n");
    return summary.exitCode;
  }
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
