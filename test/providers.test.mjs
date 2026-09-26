import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { diversityWarnings } from "../src/providers/families.mjs";
import { createAdapter, parseProviderSpec, resolveAdapters, resolveRunProviders, isKnownProvider } from "../src/providers/resolve.mjs";
import { extractText, whichBin, runCli, parseVersion, compareVersions } from "../src/providers/cli-spawn.mjs";
import {
  JUDGE_OUTPUT_SCHEMA,
  validateJudgeParsed,
  parseJudgeJson,
  parseCompareJson,
} from "../src/providers/judge-schema.mjs";
import { cliCodexTranslate, cliCodexBacktranslate, cliCodexJudge, CODEX_BASE_ARGS } from "../src/providers/cli-codex.mjs";
import { cliClaudeTranslate, cliClaudeJudge } from "../src/providers/cli-claude.mjs";
import { cliGrokTranslate } from "../src/providers/cli-grok.mjs";
import { MissingVerdictError, UnsupportedStageError } from "../src/providers/contract.mjs";
import { applyModelSelection, loadModelsConfig, presetNames } from "../src/config.mjs";
import { runDoctor } from "../src/doctor.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");
const FAKE_CODEX = join(FIX, "fake-codex.mjs");
const FAKE_CLAUDE = join(FIX, "fake-claude.mjs");
const FAKE_GROK = join(FIX, "fake-grok.mjs");
const IGNORE_SIGTERM = join(FIX, "ignore-sigterm.mjs");

function withEnv(vars, fn) {
  return async () => {
    const prev = {};
    for (const [k, v] of Object.entries(vars)) {
      prev[k] = process.env[k];
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

describe("parseProviderSpec", () => {
  const models = loadModelsConfig();

  it("resolves profiles", () => {
    assert.deepEqual(parseProviderSpec("mock"), { translate: "mock", backtranslate: "mock", judge: "mock" });
    assert.deepEqual(parseProviderSpec("fleet"), {
      translate: "cli:claude",
      backtranslate: "cli:grok",
      judge: "cli:codex",
    });
    assert.deepEqual(parseProviderSpec("openrouter"), {
      translate: `openrouter:${models.openrouter.stages.translate}`,
      backtranslate: `openrouter:${models.openrouter.stages.backtranslate}`,
      judge: `openrouter:${models.openrouter.stages.judge}`,
    });
  });

  it("uses one provider for all stages", () => {
    assert.deepEqual(parseProviderSpec("cli:grok"), {
      translate: "cli:grok",
      backtranslate: "cli:grok",
      judge: "cli:grok",
    });
    assert.equal(parseProviderSpec("openrouter:qwen/qwen3-max").judge, "openrouter:qwen/qwen3-max");
  });

  it("parses full stage maps, expanding bare openrouter per stage", () => {
    assert.deepEqual(parseProviderSpec("translate=cli:claude,backtranslate=openrouter,judge=api:jev"), {
      translate: "cli:claude",
      backtranslate: `openrouter:${models.openrouter.stages.backtranslate}`,
      judge: "api:jev",
    });
  });

  it("rejects partial stage maps", () => {
    assert.throws(() => parseProviderSpec("judge=cli:codex"), /missing "translate"/);
    assert.throws(() => parseProviderSpec("translate=cli:claude,judge=cli:codex"), /missing "backtranslate"/);
  });

  it("rejects malformed and duplicate stage-map entries", () => {
    assert.throws(
      () => parseProviderSpec("translate=mock=garbage,backtranslate=mock,judge=mock"),
      /Malformed provider stage/,
    );
    assert.throws(
      () => parseProviderSpec("translate=mock,translate=mock:alt,backtranslate=mock,judge=mock"),
      /Duplicate provider stage "translate"/,
    );
  });

  it("rejects removed vendor stubs, unknown providers and stages", () => {
    assert.throws(() => parseProviderSpec("api"), /was removed.*--profile=openrouter/);
    assert.throws(() => parseProviderSpec("translate=api:anthropic,backtranslate=mock,judge=mock"), /Unknown provider/);
    assert.throws(() => parseProviderSpec("bogus"), /Unknown provider/);
    assert.throws(
      () => parseProviderSpec("foo=cli:grok,translate=cli:claude,backtranslate=cli:grok,judge=cli:codex"),
      /Unknown provider stage/,
    );
    assert.throws(() => parseProviderSpec("api:jev"), /judge-only/);
  });

  it("validates openrouter slugs", () => {
    assert.equal(isKnownProvider("openrouter:anthropic/claude-opus-5.5"), true);
    assert.equal(isKnownProvider("openrouter:meta-llama/llama-3.1-70b-instruct:free"), true);
    assert.equal(isKnownProvider("openrouter:not-a-slug"), false);
  });
});

describe("OpenRouter model presets", () => {
  const models = loadModelsConfig();

  it("resolves every preset and validates all of its slugs", () => {
    assert.deepEqual(presetNames(models), ["balanced", "budget", "cheapest"]);
    assert.deepEqual(models.openrouter.presets.balanced.stages, models.openrouter.stages, "balanced = the defaults");
    for (const name of presetNames(models)) {
      const selected = applyModelSelection(models, { preset: name });
      const providers = resolveRunProviders({ profile: "openrouter", models: selected }).providers;
      assert.deepEqual(diversityWarnings(providers), [], `${name}: three stages must be three model families`);
      assert.deepEqual(resolveRunProviders({ profile: "openrouter", models: selected }).providers, {
        translate: `openrouter:${models.openrouter.presets[name].stages.translate}`,
        backtranslate: `openrouter:${models.openrouter.presets[name].stages.backtranslate}`,
        judge: `openrouter:${models.openrouter.presets[name].stages.judge}`,
      });
      for (const slug of [
        ...Object.values(models.openrouter.presets[name].stages),
        ...models.openrouter.presets[name].faceoff,
        ...models.openrouter.presets[name].auditJudges,
      ]) assert.equal(isKnownProvider(`openrouter:${slug}`), true, `${name}: ${slug}`);
    }
  });

  it("stage overrides beat the selected preset", () => {
    const selected = applyModelSelection(models, { preset: "budget", stageModels: { judge: "vendor/custom-model" } });
    assert.equal(selected.openrouter.stages.translate, "deepseek/deepseek-v4.1-flash");
    assert.equal(selected.openrouter.stages.judge, "vendor/custom-model");
  });

  it("rejects unknown presets and malformed override slugs", () => {
    assert.throws(() => applyModelSelection(models, { preset: "nope" }), /Unknown preset.*balanced, budget/);
    assert.throws(() => applyModelSelection(models, { stageModels: { judge: "not-a-slug" } }), /Invalid OpenRouter slug/);
  });

  it("doctor --online lists slugs from every preset", async () => {
    const all = [...new Set(Object.values(models.openrouter.presets).flatMap((p) => [
      ...Object.values(p.stages), ...p.faceoff, ...p.auditJudges,
    ]))];
    const fetchImpl = async () => ({ ok: true, json: async () => ({ data: all.map((id) => ({ id })) }) });
    const summary = await runDoctor({ online: true, fetchImpl });
    for (const slug of all) assert.equal(summary.openrouter.models[slug], true, slug);
  });
});

describe("resolveAdapters / resolveRunProviders", () => {
  it("threads model overrides into CLI and Jev adapters", () => {
    const models = structuredClone(loadModelsConfig());
    models.cli.claude.defaultModel = "override-claude";
    models.cli.codex.defaultModel = "override-codex";
    models.cli.grok.defaultModel = "override-grok";
    models.jev.defaultModel = "override-jev";
    assert.equal(createAdapter("cli:claude", { models }).describe("translate").model, process.env.CLAUDE_MODEL || "override-claude");
    assert.equal(createAdapter("cli:codex", { models }).describe("translate").model, process.env.CODEX_MODEL || "override-codex");
    assert.equal(createAdapter("cli:grok", { models }).describe("translate").model, "override-grok");
    assert.equal(createAdapter("api:jev", { models }).describe("judge").model, process.env.JEV_MODEL || "override-jev");
  });

  it("builds adapters for every fleet stage", () => {
    const a = resolveAdapters(parseProviderSpec("fleet"));
    for (const s of ["translate", "backtranslate", "judge"]) assert.equal(typeof a[s][s], "function");
  });

  it("rejects api:jev outside judge", () => {
    assert.throws(
      () => resolveAdapters({ translate: "api:jev", backtranslate: "mock", judge: "mock" }),
      UnsupportedStageError,
    );
  });

  it("precedence: --mock > --provider > --profile > env > default", () => {
    assert.equal(resolveRunProviders({ mock: true, profile: "fleet" }).profile, "mock");
    assert.equal(resolveRunProviders({ provider: "cli:grok", profile: "fleet" }).profile, "custom");
    assert.equal(resolveRunProviders({ profile: "fleet", env: { COUNCIL_PROFILE: "openrouter" } }).profile, "fleet");
    assert.equal(resolveRunProviders({ env: { COUNCIL_PROFILE: "openrouter" } }).profile, "openrouter");
    assert.equal(resolveRunProviders({ env: {} }).profile, "mock");
  });

  it("custom stage maps get a panel from their distinct providers", () => {
    const r = resolveRunProviders({ provider: "translate=cli:claude,backtranslate=cli:grok,judge=api:jev", env: {} });
    assert.deepEqual(r.faceoff, ["cli:claude", "cli:grok"]);
    assert.deepEqual(r.auditJudges, ["cli:claude", "cli:grok", "api:jev"]);
  });
});

describe("extractText", () => {
  it("unwraps common JSON envelopes", () => {
    assert.equal(extractText('"plain"'), "plain");
    assert.equal(extractText(JSON.stringify({ result: "hi" })), "hi");
    assert.equal(extractText(JSON.stringify({ text: "t" })), "t");
    assert.equal(extractText(JSON.stringify({ content: [{ type: "text", text: "ab" }] })), "ab");
  });

  it("falls back to trimmed plain text", () => {
    assert.equal(extractText("  hello  "), "hello");
  });

  it("rejects is_error envelopes", () => {
    assert.throws(() => extractText(JSON.stringify({ is_error: true, result: "nope" })), /is_error/);
  });
});

describe("whichBin / versions", () => {
  it("resolves an absolute executable path", async () => {
    assert.equal(await whichBin(process.execPath), process.execPath);
  });

  it("resolves a path containing / to an absolute path", async () => {
    assert.equal(await whichBin(FAKE_CODEX), FAKE_CODEX);
  });

  it("rejects missing absolute path", async () => {
    await assert.rejects(() => whichBin("/nonexistent/lc-bin-xyz"), /not found or not executable/);
  });

  it("parses and compares versions", () => {
    assert.equal(parseVersion("2.1.300 (Claude Code)"), "2.1.300");
    assert.equal(parseVersion("codex-cli 0.50.0"), "0.50.0");
    assert.equal(parseVersion("nope"), null);
    assert.equal(compareVersions("2.1.300", "2.1.280"), 1);
    assert.equal(compareVersions("1.0.34", "1.0.34"), 0);
    assert.equal(compareVersions("1.0.9", "1.0.34"), -1);
  });
});

describe("runCli timeouts", () => {
  it("sends SIGKILL after the grace period when the child ignores SIGTERM", async () => {
    const dir = join(tmpdir(), `lc-sigkill-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const pidFile = join(dir, "pid");
    const marker = join(dir, "marker");
    // Give the child time to start and install its SIGTERM handler (slow CI runners).
    await assert.rejects(
      () => runCli(process.execPath, [IGNORE_SIGTERM, pidFile, marker], { timeoutMs: 1500, killGraceMs: 200 }),
      /timed out/,
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    const isAlive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // The child ignores SIGTERM, so it can only die from the SIGKILL. Poll rather than
    // sleep a fixed time: reaping the killed child can lag on a busy machine.
    const deadline = Date.now() + 5000;
    while (isAlive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const alive = isAlive();
    assert.ok(existsSync(marker), "SIGTERM handler should have run (and ignored the signal)");
    assert.equal(alive, false, "child must be dead after SIGKILL grace");
  });

  it("a CLI that exits without reading stdin is an error, not a crash (EPIPE)", async () => {
    await assert.rejects(
      () =>
        runCli(process.execPath, ["-e", "process.stderr.write('bad flag'); process.exit(3)"], {
          input: "x".repeat(4 * 1024 * 1024),
          timeoutMs: 10_000,
        }),
      /exited 3[\s\S]*bad flag/,
    );
  });

  it("captures stderr in the failure message", async () => {
    await assert.rejects(
      () => runCli(process.execPath, ["-e", "process.stderr.write('boom-detail'); process.exit(3)"], { timeoutMs: 5000 }),
      /exited 3[\s\S]*boom-detail/,
    );
  });
});

describe("judge / compare parsing fails closed", () => {
  it("schema is strict and loaded from schemas/", () => {
    assert.ok(JUDGE_OUTPUT_SCHEMA.required.includes("glossaryOk"));
    assert.ok(JUDGE_OUTPUT_SCHEMA.required.includes("fluency"));
    assert.equal(JUDGE_OUTPUT_SCHEMA.additionalProperties, false);
  });

  it("rejects NaN / out-of-range meaning", () => {
    const base = { fluency: 0.5, glossaryOk: true, escalate: false, rationale: "x" };
    assert.throws(() => validateJudgeParsed({ ...base, meaning: "nope" }, { provider: "t", key: "k" }), /invalid meaning/);
    assert.throws(() => validateJudgeParsed({ ...base, meaning: 1.5 }, { provider: "t", key: "k" }), /invalid meaning/);
    assert.throws(() => validateJudgeParsed({ ...base, meaning: null }, { provider: "t", key: "k" }), MissingVerdictError);
  });

  it("rejects non-number scores instead of coercing them (true, \"1\", [1])", () => {
    for (const bad of [true, "1", [1], "0.9"]) {
      assert.throws(
        () =>
          parseJudgeJson(JSON.stringify({ meaning: bad, fluency: 0.9, glossaryOk: true, escalate: false, rationale: "" }), {
            provider: "t",
            key: "k",
          }),
        /invalid meaning/,
        JSON.stringify(bad),
      );
    }
    assert.throws(
      () =>
        parseJudgeJson(JSON.stringify({ meaning: 0.9, fluency: true, glossaryOk: true, escalate: false, rationale: "" }), {
          provider: "t",
          key: "k",
        }),
      /invalid fluency/,
    );
  });

  it("fails closed when a glossary was supplied but glossaryOk is missing", () => {
    assert.throws(
      () =>
        validateJudgeParsed(
          { meaning: 0.9, fluency: 0.9, escalate: false, rationale: "x" },
          { provider: "t", key: "k", glossary: { locale: "de", entries: [] } },
        ),
      /glossaryOk/,
    );
  });

  it("escalates on glossaryOk false even if the judge's escalate flag is false", () => {
    const r = validateJudgeParsed(
      { meaning: 0.95, fluency: 0.9, glossaryOk: false, escalate: false, rationale: "term drift" },
      { provider: "t", key: "k" },
    );
    assert.equal(r.escalate, true);
  });

  it("leaves the meaning threshold to the pipeline", () => {
    const r = validateJudgeParsed(
      { meaning: 0.6, fluency: 0.9, glossaryOk: true, escalate: false, rationale: "ok" },
      { provider: "t", key: "k" },
    );
    assert.equal(r.escalate, false);
  });

  it("empty output is a missing verdict, never a pass", () => {
    assert.throws(() => parseJudgeJson("   ", { provider: "t", key: "k" }), MissingVerdictError);
    assert.throws(() => parseCompareJson("", { provider: "t", key: "k", labels: ["X", "Y"] }), MissingVerdictError);
  });

  it("unwraps a Claude result envelope", () => {
    const r = parseJudgeJson(
      JSON.stringify({
        subtype: "success",
        result: { meaning: 0.8, fluency: 0.7, glossaryOk: true, escalate: false, rationale: "ok" },
      }),
      { provider: "cli:claude", key: "k" },
    );
    assert.equal(r.meaning, 0.8);
  });

  it("compare: a pick outside the labels is a missing verdict; none is an explicit abstain", () => {
    assert.throws(
      () => parseCompareJson(JSON.stringify({ pick: "Q", rationale: "" }), { provider: "t", key: "k", labels: ["X", "Y"] }),
      /not one of X\/Y\/none/,
    );
    assert.equal(
      parseCompareJson(JSON.stringify({ pick: "none", rationale: "all wrong" }), { provider: "t", key: "k", labels: ["X"] }).pick,
      "none",
    );
  });
});

describe("cli:codex adapter", () => {
  it(
    "prefers -o last-message over JSONL noise",
    withEnv({ CODEX_CLI_BIN: FAKE_CODEX, CODEX_TIMEOUT_MS: "10000" }, async () => {
      const t = await cliCodexTranslate({ text: "Play", locale: "de", key: "play" });
      assert.equal(t.candidate, "Abspielen");
      const bt = await cliCodexBacktranslate({ text: "Abspielen", locale: "de", key: "play" });
      assert.equal(bt.backtranslation, "Play");
      const j = await cliCodexJudge({
        source: "Play",
        candidate: "Abspielen",
        backtranslation: "Play",
        key: "play",
        locale: "de",
        glossary: { schemaVersion: "0", locale: "de", entries: [] },
      });
      assert.ok(j.meaning >= 0.75 && j.meaning <= 1);
      assert.equal(j.glossaryOk, true);
      assert.equal(j.escalate, false);
    }),
  );

  it("always passes --skip-git-repo-check (the fake fails like real codex without it)", () => {
    assert.ok(CODEX_BASE_ARGS.includes("--skip-git-repo-check"));
  });

  it(
    "reports empty output as a missing verdict",
    withEnv({ CODEX_CLI_BIN: FAKE_CODEX, FAKE_CLI_EMPTY: "1" }, async () => {
      await assert.rejects(() => cliCodexTranslate({ text: "Play", locale: "de", key: "play" }), MissingVerdictError);
    }),
  );
});

describe("cli:claude adapter", () => {
  it("uses json output, tool deny, stdin prompt, schema judge", async () => {
    const argsLog = join(tmpdir(), `fake-claude-args-${Date.now()}.json`);
    await withEnv({ CLAUDE_CLI_BIN: FAKE_CLAUDE, FAKE_CLAUDE_ARGS_LOG: argsLog, CLAUDE_TIMEOUT_MS: "10000" }, async () => {
      const t = await cliClaudeTranslate({ text: "Play", locale: "de", key: "play" });
      assert.equal(t.candidate, "Abspielen");
      const args = JSON.parse(readFileSync(argsLog, "utf8"));
      assert.ok(args.includes("--disallowedTools"));
      assert.ok(args.includes("dontAsk"));
      assert.ok(args[args.indexOf("-p") + 1]?.startsWith("--"), "prompt must go on stdin, not argv");
      assert.equal(args[args.indexOf("--model") + 1], loadModelsConfig().cli.claude.defaultModel);

      const j = await cliClaudeJudge({
        source: "Play",
        candidate: "Abspielen",
        backtranslation: "Play",
        key: "play",
        locale: "de",
        glossary: { schemaVersion: "0", locale: "de", entries: [] },
      });
      assert.equal(j.glossaryOk, true);
      assert.ok(j.meaning > 0.75);
    })();
  });

  it(
    "reports empty output as a missing verdict",
    withEnv({ CLAUDE_CLI_BIN: FAKE_CLAUDE, FAKE_CLI_EMPTY: "1" }, async () => {
      await assert.rejects(() => cliClaudeTranslate({ text: "Play", locale: "de", key: "play" }), /empty output/);
    }),
  );
});

describe("cli:grok adapter", () => {
  it(
    "translates via -p and json output",
    withEnv({ GROK_CLI_BIN: FAKE_GROK }, async () => {
      const t = await cliGrokTranslate({ text: "Rendering…", locale: "de", key: "r" });
      assert.equal(t.candidate, "Rendern…");
    }),
  );
});
