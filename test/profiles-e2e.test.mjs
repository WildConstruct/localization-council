/**
 * The launch bar: the same `council run` works with --profile=mock,
 * --profile=openrouter (local fake OpenRouter server) and --profile=fleet
 * (fake CLIs), and all three produce identical artifact shapes and an
 * identical --json summary schema. No live calls.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startFakeOpenRouter } from "./helpers/fake-openrouter.mjs";
import { validate, validateDef } from "../src/json-schema.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIX = join(__dirname, "fixtures");
const CLI = join(ROOT, "src", "cli.mjs");

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).replace(/results\/[^/]+\.json$/, "results/<judge>.json"));
    }
  };
  walk(dir);
  return [...new Set(out)].sort();
}

/** Structural shape: object keys and value types (arrays by their first element). */
function shape(v) {
  if (v === null) return "null|value";
  if (Array.isArray(v)) return v.length ? ["array", shape(v[0])] : ["array"];
  if (typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? typeof v : "value";
}

/** Shapes, but arrays compared only as "array" (contents vary with outcomes). */
function topShape(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, Array.isArray(v[k]) ? "array" : v[k] === null ? "null" : typeof v[k] === "object" ? topShape(v[k]) : typeof v[k]]));
  }
  return Array.isArray(v) ? "array" : typeof v;
}

describe("profile parity: mock / openrouter / fleet", () => {
  let server;
  const results = {};

  before(async () => {
    server = await startFakeOpenRouter();
    const env = {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_BASE_URL: server.url,
      CLAUDE_CLI_BIN: join(FIX, "fake-claude.mjs"),
      GROK_CLI_BIN: join(FIX, "fake-grok.mjs"),
      CODEX_CLI_BIN: join(FIX, "fake-codex.mjs"),
    };
    await Promise.all(
      ["mock", "openrouter", "fleet"].map(async (profile) => {
        const out = mkdtempSync(join(tmpdir(), `lc-parity-${profile}-`));
        const r = await runCli(
          [
            "run",
            "--catalog", "fixtures/toy/en.json",
            "--locale", "de",
            "--glossary", "fixtures/toy/glossary.de.json",
            `--profile=${profile}`,
            "--out", out,
            "--faceoff", "--consensus-cull", "--blind-audit",
            "--json",
          ],
          env,
        );
        results[profile] = { ...r, out };
      }),
    );
    const out = mkdtempSync(join(tmpdir(), "lc-preset-budget-"));
    results.budget = {
      ...(await runCli([
        "run", "--catalog", "fixtures/toy/en.json", "--locale", "de", "--glossary", "fixtures/toy/glossary.de.json",
        "--preset", "budget", "--out", out, "--json",
      ], { ...env, COUNCIL_PROFILE: "", COUNCIL_PROVIDER: "", COUNCIL_PRESET: "" })),
      out,
    };
  });

  after(async () => {
    await server?.close();
  });

  it("each profile prints exactly one schema-valid summary and exits with its exitCode", () => {
    for (const profile of ["mock", "openrouter", "fleet"]) {
      const r = results[profile];
      assert.ok(r.stdout.trim(), `${profile} printed nothing; stderr: ${r.stderr}`);
      const s = JSON.parse(r.stdout);
      assert.ok(validate(s, "summary.v1.json").ok, profile);
      const run = validateDef(s, "summary.v1.json", "run");
      assert.ok(run.ok, `${profile}: ${run.errors.join("; ")}`);
      assert.equal(r.code, s.exitCode, `${profile} exit code`);
      assert.equal(s.profile, profile);
      assert.deepEqual(s.errors, [], `${profile}: ${r.stderr}`);
      results[profile].summary = s;
    }
  });

  it("summaries have identical shapes", () => {
    const [a, b, c] = ["mock", "openrouter", "fleet"].map((p) => topShape(results[p].summary));
    assert.deepEqual(b, a);
    assert.deepEqual(c, a);
  });

  it("artifact files are identical across profiles", () => {
    const [a, b, c] = ["mock", "openrouter", "fleet"].map((p) => files(results[p].out));
    assert.deepEqual(b, a);
    assert.deepEqual(c, a);
    for (const f of ["candidates.json", "backtranslations.json", "scores.json", "escalate.json", "accepted.json", "report.md", "manifest.json", "faceoff.json"]) {
      assert.ok(a.includes(f), f);
    }
  });

  it("artifact JSON rows have identical shapes", () => {
    for (const f of ["candidates.json", "backtranslations.json", "scores.json"]) {
      const [a, b, c] = ["mock", "openrouter", "fleet"].map((p) => shape(JSON.parse(readFileSync(join(results[p].out, f), "utf8"))[0]));
      // model is a string for every real provider
      assert.deepEqual(b, a, `${f} openrouter`);
      assert.deepEqual(c, a, `${f} fleet`);
    }
    for (const f of ["escalate.json", "accepted.json", "manifest.json"]) {
      const [a, b, c] = ["mock", "openrouter", "fleet"].map((p) => Object.keys(JSON.parse(readFileSync(join(results[p].out, f), "utf8"))).sort());
      assert.deepEqual(b, a, f);
      assert.deepEqual(c, a, f);
    }
  });

  it("the openrouter run used the configured stage models and recorded response.model + cost", () => {
    const m = JSON.parse(readFileSync(join(results.openrouter.out, "manifest.json"), "utf8"));
    const models = JSON.parse(readFileSync(join(ROOT, "config", "models.json"), "utf8")).openrouter.stages;
    assert.equal(m.models.translate.requested, models.translate);
    assert.ok(m.models.translate.resolved.includes(`${models.translate}-20260901`));
    assert.ok(m.cost.usd > 0);
    assert.equal(m.cost.complete, true);
    assert.ok(server.requests.every((r) => r.body.response_format?.type === "json_schema"));
  });

  it("the fleet run recorded CLI versions", () => {
    const m = JSON.parse(readFileSync(join(results.fleet.out, "manifest.json"), "utf8"));
    assert.equal(m.tools.cli.claude.version, "2.1.300");
    assert.equal(m.tools.cli.grok.version, "1.0.40");
    assert.equal(m.tools.cli.codex.version, "0.50.0");
  });

  it("a preset with no profile selects OpenRouter and records its model selection", () => {
    const r = results.budget;
    assert.equal(r.code, JSON.parse(r.stdout).exitCode, r.stderr);
    const m = JSON.parse(readFileSync(join(r.out, "manifest.json"), "utf8"));
    const budget = JSON.parse(readFileSync(join(ROOT, "config", "models.json"), "utf8")).openrouter.presets.budget.stages;
    assert.equal(m.profile, "openrouter");
    assert.equal(m.preset, "budget");
    assert.deepEqual(m.stageModels, {});
    for (const stage of Object.keys(budget)) assert.equal(m.models[stage].requested, budget[stage]);
  });
});
