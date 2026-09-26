/**
 * Provider contract: every adapter (mock, cli:*, openrouter:*, api:jev)
 * runs translate / backtranslate / judge / compare on the same batches and
 * must return rows that match schemas/stage-results.v1.json. Stages an
 * adapter cannot run must throw UnsupportedStageError.
 *
 * No live calls: CLIs are the fakes in test/fixtures, HTTP providers replay
 * test/fixtures/recorded/.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapter, supportedStages } from "../src/providers/resolve.mjs";
import { normalizeStageResults, UnsupportedStageError, STAGES } from "../src/providers/contract.mjs";
import { validateDef } from "../src/json-schema.mjs";
import { Telemetry } from "../src/run-context.mjs";
import { CONTRACT_BATCHES } from "./fixtures/contract-batches.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");
const REC = join(FIX, "recorded");
const BATCHES = CONTRACT_BATCHES;

function recorded(dir, name) {
  return readFileSync(join(REC, dir, `${name}.json`), "utf8");
}

/** fetch that replays recorded bodies, picked by the request's stage. */
function replayFetch(calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    let text;
    if (url.endsWith("/chat/completions")) {
      text = recorded("openrouter", body.response_format.json_schema.name.replace("council_", ""));
    } else {
      text = recorded("jev", body.questions.winner ? "compare" : "judge");
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text };
  };
}

const ADAPTERS = [
  "mock",
  "mock:alt",
  "mock:third",
  "cli:claude",
  "cli:grok",
  "cli:codex",
  "openrouter:anthropic/claude-opus-5.5",
  "api:jev",
];

describe("provider contract", () => {
  const saved = {};
  before(() => {
    for (const [k, v] of Object.entries({
      CLAUDE_CLI_BIN: join(FIX, "fake-claude.mjs"),
      GROK_CLI_BIN: join(FIX, "fake-grok.mjs"),
      CODEX_CLI_BIN: join(FIX, "fake-codex.mjs"),
      OPENROUTER_API_KEY: "test-key",
    })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  });

  for (const id of ADAPTERS) {
    describe(id, () => {
      for (const stage of STAGES) {
        it(`${stage} → schema-valid rows, or UnsupportedStageError`, async () => {
          const calls = [];
          const adapter = createAdapter(id, { fetchImpl: replayFetch(calls), sleep: async () => {} });
          const desc = adapter.describe(stage);
          assert.equal(desc.provider, id);
          assert.equal(typeof desc.promptVersion, "string");
          assert.equal(typeof adapter.family, "string");
          const batch = BATCHES[stage];
          const ctx = { telemetry: new Telemetry(), log() {} };

          if (!supportedStages(id).includes(stage)) {
            await assert.rejects(() => adapter[stage](batch, ctx), UnsupportedStageError);
            return;
          }
          const raw = await adapter[stage](batch, ctx);
          const rows = normalizeStageResults(stage, batch, raw, desc);
          assert.equal(rows.length, batch.items.length);
          rows.forEach((row, i) => {
            assert.equal(row.key, batch.items[i].key);
            const { ok, errors } = validateDef(row, "stage-results.v1.json", stage);
            assert.ok(ok, `${id} ${stage}: ${errors.join("; ")}`);
          });
          if (id.startsWith("openrouter:") || id === "api:jev") {
            assert.ok(calls.length >= 1, "HTTP adapter must have called fetch");
            const t = ctx.telemetry.summary();
            assert.ok(t.byStage[stage].resolvedModels.length, "response.model must be recorded");
            assert.ok(t.costUsd > 0, "usage.cost must be recorded");
          }
        });
      }
    });
  }

  it("openrouter judge rows keep the recorded verdicts", async () => {
    const adapter = createAdapter("openrouter:openai/gpt-5.6-sol", { fetchImpl: replayFetch([]) });
    const rows = await adapter.judge(BATCHES.judge, { telemetry: new Telemetry() });
    const onion = rows.find((r) => r.key === "ui.viewport.onion");
    assert.equal(onion.glossaryOk, false);
    assert.equal(onion.escalate, true);
    assert.equal(onion.model, "openai/gpt-5.6-sol");
  });

  it("api:jev compare votes only when the faceoff gate passes", async () => {
    const adapter = createAdapter("api:jev", { fetchImpl: replayFetch([]) });
    const [row] = await adapter.compare(BATCHES.compare, { telemetry: new Telemetry() });
    assert.equal(row.pick, "X");
  });
});
