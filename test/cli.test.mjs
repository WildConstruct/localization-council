/**
 * The machine contract: --json prints one summary object, exit codes are
 * stable (0 clean · 10 escalations/reopens · 1 error · 2 usage · 3 preflight),
 * and human mode stays quiet when there is nothing to do.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validate, validateDef } from "../src/json-schema.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIX = join(__dirname, "fixtures");
const CLI = join(ROOT, "src", "cli.mjs");

const FAKES = {
  CLAUDE_CLI_BIN: join(FIX, "fake-claude.mjs"),
  GROK_CLI_BIN: join(FIX, "fake-grok.mjs"),
  CODEX_CLI_BIN: join(FIX, "fake-codex.mjs"),
};

function council(args, env = {}) {
  const clean = { ...process.env };
  delete clean.COUNCIL_PROFILE;
  delete clean.COUNCIL_PROVIDER;
  delete clean.COUNCIL_PRESET;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env: { ...clean, ...env }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function json(r) {
  const s = JSON.parse(r.stdout);
  const env = validate(s, "summary.v1.json");
  assert.ok(env.ok, env.errors.join("; "));
  return s;
}

const tmp = () => mkdtempSync(join(tmpdir(), "lc-cli-"));
const RUN = ["run", "--catalog", "fixtures/toy/en.json", "--locale", "de", "--glossary", "fixtures/toy/glossary.de.json", "--profile=mock"];

describe("council run", () => {
  it("root summary validation dispatches to the command schema", () => {
    const invalid = {
      schema: "council.summary.v1",
      command: "run",
      councilVersion: "x",
      status: "totally-invalid",
      exitCode: 999,
      warnings: [],
      errors: [],
    };
    assert.equal(validate(invalid, "summary.v1.json").ok, false);
  });

  it("--json: one summary object, exit 10 when escalations exist", () => {
    const r = council([...RUN, "--out", tmp(), "--json"]);
    assert.equal(r.code, 10);
    const s = json(r);
    assert.ok(validateDef(s, "summary.v1.json", "run").ok);
    assert.equal(s.status, "escalations");
    assert.equal(s.exitCode, 10);
  });

  it("human mode lists escalations and where to look", () => {
    const r = council([...RUN, "--out", tmp()]);
    assert.equal(r.code, 10);
    assert.match(r.stdout, /3 escalation\(s\)/);
    assert.match(r.stdout, /ui\.viewport\.onion/);
    assert.match(r.stdout, /report\.md/);
  });

  it("is quiet and exits 0 when clean", () => {
    const r = council([...RUN, "--out", tmp(), "--keys", "ui.timeline.play,ui.timeline.pause"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("is quiet and exits 0 when there is no delta", () => {
    const dir = tmp();
    const en = JSON.parse(readFileSync(join(ROOT, "fixtures/toy/en.json"), "utf8"));
    writeFileSync(join(dir, "de.json"), JSON.stringify(Object.fromEntries(Object.keys(en).map((k) => [k, `x ${k}`]))));
    const r = council([...RUN, "--out", join(dir, "out"), "--target", join(dir, "de.json")]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("does not note the mock fallback when there is no delta", () => {
    const dir = tmp();
    const en = JSON.parse(readFileSync(join(ROOT, "fixtures/toy/en.json"), "utf8"));
    writeFileSync(join(dir, "de.json"), JSON.stringify(Object.fromEntries(Object.keys(en).map((k) => [k, `x ${k}`]))));
    const r = council([
      "run", "--catalog", "fixtures/toy/en.json", "--locale", "de", "--out", join(dir, "out"), "--target", join(dir, "de.json"),
    ]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  });

  it("notes the mock fallback on stderr when no profile is given", () => {
    const r = council(["run", "--catalog", "fixtures/toy/en.json", "--locale", "de", "--out", tmp(), "--keys", "ui.timeline.play"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /using the offline mock profile/);
  });

  it("post-escalate flags resolve everything in the offline demo (exit 0)", () => {
    const r = council([...RUN, "--out", tmp(), "--faceoff", "--consensus-cull", "--blind-audit", "--json"]);
    assert.equal(r.code, 0);
    assert.equal(json(r).counts.escalated, 0);
  });
});

describe("errors", () => {
  it("unknown option → exit 2, error summary with --json", () => {
    const r = council([...RUN, "--out", tmp(), "--bogus", "1", "--json"]);
    assert.equal(r.code, 2);
    const s = json(r);
    assert.equal(s.status, "error");
    assert.equal(s.exitCode, 2);
    assert.match(s.errors[0].message, /Unknown option --bogus/);
    assert.ok(validateDef(s, "summary.v1.json", "run").ok, "error summaries keep the run shape");
    assert.match(r.stderr, /error:/);
  });

  it("missing required flag → exit 2", () => {
    const r = council(["run", "--locale", "de"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /requires --catalog/);
  });

  it("runtime failure → exit 1 (missing catalog file)", () => {
    const r = council(["run", "--catalog", "nope.json", "--locale", "de", "--profile=mock", "--json"]);
    assert.equal(r.code, 1);
    assert.equal(json(r).status, "error");
  });

  it("removed vendor providers explain the replacement (usage error, exit 2)", () => {
    const r = council([...RUN.slice(0, -1), "--provider=api", "--out", tmp()]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--profile=openrouter/);
  });

  it("bad profiles, providers and numbers are usage errors (exit 2), caught before any work", () => {
    assert.equal(council([...RUN.slice(0, -1), "--profile=bogus", "--out", tmp()]).code, 2);
    assert.equal(council([...RUN.slice(0, -1), "--provider=translate=mock,judge=mock", "--out", tmp()]).code, 2);
    assert.equal(council([...RUN, "--meaning-threshold=abc", "--out", tmp()]).code, 2);
    assert.equal(council([...RUN, "--meaning-threshold=", "--out", tmp()]).code, 2);
    assert.equal(council([...RUN, "--consensus-min=1", "--consensus-cull", "--out", tmp()]).code, 2);
    const out = join(tmp(), "never-created");
    const r = council([...RUN, "--faceoff", "--faceoff-providers=nope", "--out", out]);
    assert.equal(r.code, 2);
    assert.equal(existsSync(out), false, "no core stages ran");
  });

  it("rejects an unknown preset and a preset paired with a non-OpenRouter profile", () => {
    const unknown = council([...RUN, "--preset", "nope", "--out", tmp(), "--json"]);
    assert.equal(unknown.code, 2);
    assert.match(json(unknown).errors[0].message, /Unknown preset.*balanced, budget/);
    const mock = council([...RUN, "--preset", "budget", "--out", tmp(), "--json"]);
    assert.equal(mock.code, 2);
    assert.match(json(mock).errors[0].message, /only affect OpenRouter stages/);
  });

  it("COUNCIL_PRESET in the environment does not break mock or fleet runs", () => {
    const r = council([...RUN, "--out", tmp(), "--json"], { COUNCIL_PRESET: "budget" });
    assert.equal(r.code, 10, r.stderr);
    assert.equal(json(r).preset, null);
  });

  it("error summaries keep each command's shape", () => {
    const cases = [
      ["diff", ["diff", "--source", "nope.json", "--target", "nope.json", "--json"]],
      ["tidy", ["tidy", "--locale", "ja", "--json"]],
      ["garden", ["garden", "--json"]],
      ["doctor", ["doctor", "--profile", "bogus", "--json"]],
    ];
    for (const [cmd, args] of cases) {
      const s = json(council(args));
      assert.equal(s.status, "error", cmd);
      const d = validateDef(s, "summary.v1.json", cmd);
      assert.ok(d.ok, `${cmd}: ${d.errors.join("; ")}`);
    }
  });

  it("openrouter without a key fails fast with a pointer to doctor", () => {
    const r = council([...RUN.slice(0, -1), "--profile=openrouter", "--out", tmp()], { OPENROUTER_API_KEY: "" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /OPENROUTER_API_KEY/);
  });
});

describe("council diff", () => {
  it("--json envelope keeps missing/untranslated arrays", () => {
    const r = council(["diff", "--source", "fixtures/toy/en.json", "--target", "fixtures/toy/de.json", "--json"]);
    assert.equal(r.code, 0);
    const s = json(r);
    assert.ok(validateDef(s, "summary.v1.json", "diff").ok);
    assert.equal(s.status, "delta");
    assert.equal(s.delta, s.missing.length + s.untranslated.length);
  });

  it("human mode is quiet with no delta", () => {
    const r = council(["diff", "--source", "fixtures/toy/en.json", "--target", "fixtures/toy/en.json"]);
    // en vs en: every key is "identical to source", which is a delta
    assert.match(r.stdout, /identical_to_source/);
    const r2 = council(["diff", "--source", "fixtures/website/de.common.json", "--target", "fixtures/website/de.common.json", "--json"]);
    assert.equal(r2.code, 0);
  });
});

describe("council doctor", () => {
  it("--json reports CLIs, keys, runnable profiles and a recommendation", () => {
    const r = council(["doctor", "--json"], { ...FAKES, OPENROUTER_API_KEY: "k" });
    assert.equal(r.code, 0);
    const s = json(r);
    const d = validateDef(s, "summary.v1.json", "doctor");
    assert.ok(d.ok, d.errors.join("; "));
    assert.equal(s.clis.claude.installed, true);
    assert.equal(s.clis.claude.version, "2.1.300");
    assert.equal(s.clis.claude.versionOk, true);
    assert.equal(s.keys.OPENROUTER_API_KEY, true);
    assert.equal(s.profiles.fleet.runnable, true);
    assert.equal(s.profiles.openrouter.runnable, true);
    assert.equal(s.profiles.mock.runnable, true);
    assert.equal(s.recommendedProfile, "fleet");
    assert.doesNotMatch(r.stdout, /"k"/, "key values are never printed");
  });

  it("recommends openrouter when only the key is present, mock when nothing is", () => {
    const none = { CLAUDE_CLI_BIN: "/nonexistent/claude", GROK_CLI_BIN: "/nonexistent/grok", CODEX_CLI_BIN: "/nonexistent/codex" };
    assert.equal(json(council(["doctor", "--json"], { ...none, OPENROUTER_API_KEY: "k" })).recommendedProfile, "openrouter");
    const s = json(council(["doctor", "--json"], { ...none, OPENROUTER_API_KEY: "" }));
    assert.equal(s.recommendedProfile, "mock");
    assert.deepEqual(s.profiles.fleet.missing, ["cli:claude", "cli:grok", "cli:codex"]);
    assert.deepEqual(s.profiles.openrouter.missing, ["env:OPENROUTER_API_KEY"]);
  });

  it("--profile exits 3 when that profile is not runnable", () => {
    const r = council(["doctor", "--profile", "openrouter", "--json"], { OPENROUTER_API_KEY: "" });
    assert.equal(r.code, 3);
    assert.equal(json(r).status, "not_runnable");
  });

  it("human output names the recommended profile", () => {
    const r = council(["doctor"], { ...FAKES });
    assert.match(r.stdout, /Recommended: --profile=/);
  });
});

describe("council tidy", () => {
  const TIDY = [
    "tidy",
    "--catalog", "fixtures/tidy-sample/en.json",
    "--locale-file", "fixtures/tidy-sample/ja.json",
    "--locale", "ja",
    "--glossary", "fixtures/tidy-sample/glossary.ja.json",
    "--profile=mock",
  ];

  it("re-judges shipped rows with the profile judge; exit 10 when rows reopen", () => {
    const r = council([...TIDY, "--bt-file", "fixtures/tidy-sample/bt.ja.json", "--out", tmp(), "--json"]);
    assert.equal(r.code, 10);
    const s = json(r);
    assert.ok(validateDef(s, "summary.v1.json", "tidy").ok);
    assert.equal(s.judge, "mock");
    assert.equal(s.counts.rows, 6);
  });

  it("ignores a back-translation made from an older wording", () => {
    const dir = tmp();
    writeFileSync(join(dir, "en.json"), JSON.stringify({ "ui.status.rendering": "Rendering…" }));
    writeFileSync(join(dir, "de.json"), JSON.stringify({ "ui.status.rendering": "Wird verarbeitet…" }));
    writeFileSync(
      join(dir, "bt.json"),
      JSON.stringify([{ key: "ui.status.rendering", candidate: "Wird gerendert…", backtranslation: "Rendering…" }]),
    );
    const args = ["tidy", "--catalog", join(dir, "en.json"), "--locale-file", join(dir, "de.json"), "--locale", "de", "--bt-file", join(dir, "bt.json"), "--profile=mock", "--json"];
    const stale = json(council([...args, "--out", join(dir, "a")]));
    assert.equal(stale.exitCode, 10, "the stale BT must not make the row look clean");
    assert.equal(stale.counts.btStale, 1);
    const regen = json(council([...args, "--generate-bt", "--out", join(dir, "b")]));
    assert.equal(regen.counts.btGenerated, 1);
    assert.equal(regen.reopen[0].why_bucket, "meaning");
  });

  it("writes a manifest that matches its schema", () => {
    const out = tmp();
    council([...TIDY, "--bt-file", "fixtures/tidy-sample/bt.ja.json", "--out", out, "--json"]);
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    const v = validate(m, "tidy-manifest.v1.json");
    assert.ok(v.ok, v.errors.join("; "));
  });

  it("rows without a back-translation reopen for a human; --generate-bt fills them", () => {
    const without = json(council([...TIDY, "--out", tmp(), "--json"]));
    assert.equal(without.counts.btMissing, 6);
    const withGen = json(council([...TIDY, "--generate-bt", "--out", tmp(), "--json"]));
    assert.equal(withGen.counts.btMissing, 0);
    assert.equal(withGen.counts.btGenerated, 6);
  });
});

describe("council garden / help / version", () => {
  it("garden --json reports missing checkouts as errors (exit 1)", () => {
    const r = council(["garden", "--manifest", "examples/garden.example.json", "--root", tmp(), "--json"]);
    assert.equal(r.code, 1);
    const s = json(r);
    assert.equal(s.status, "errors");
    assert.ok(s.errors.length > 0);
  });

  it("help and version", () => {
    assert.match(council(["help"]).stdout, /--keys <k1,k2,…>\s+only these catalog keys/);
    assert.match(council(["--version"]).stdout, /^\d+\.\d+\.\d+/);
    json(council(["version", "--json"]));
    const h = json(council(["help", "--json"]));
    assert.ok(validateDef(h, "summary.v1.json", "help").ok);
    assert.match(h.usage, /council doctor/);
  });
});
