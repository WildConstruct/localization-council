import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  buildJevJudgeState,
  buildJevJudgeQuestions,
  mapJevAnswersToJudge,
  jevDecide,
  jevOpenRouterJudge,
  resolveOpenRouterApiKey,
  jevConfidenceUnsure,
  JEV_PROVIDER_ID,
  JEV_MEANING_THRESHOLD,
  JEV_DEFAULT_MODEL,
  JEV_CONFIDENCE_FLOOR,
  JEV_LEAN_STATE_KEYS,
} from "../src/providers/jev-openrouter.mjs";
import { parseProviderSpec, resolveAdapters } from "../src/providers/resolve.mjs";

describe("resolve api:jev", () => {
  it("resolves judge=api:jev and alias jev", () => {
    const a = parseProviderSpec(
      "translate=cli:claude,backtranslate=cli:grok,judge=api:jev",
    );
    assert.equal(a.judge, "api:jev");
    const adapters = resolveAdapters(a);
    assert.equal(adapters.judge.id, "api:jev");

    const b = parseProviderSpec(
      "translate=mock,backtranslate=mock,judge=jev",
    );
    assert.equal(b.judge, "jev");
    assert.equal(typeof resolveAdapters(b).judge.judge, "function");
  });

  it("rejects api:jev as translate", () => {
    assert.throws(
      () =>
        resolveAdapters({
          translate: "api:jev",
          backtranslate: "mock",
          judge: "mock",
        }),
      /does not support the translate stage/,
    );
  });

  it("uses model and Decisions URL overrides from the merged models config", async () => {
    const previousModel = process.env.JEV_MODEL;
    const previousUrl = process.env.JEV_DECISIONS_URL;
    delete process.env.JEV_MODEL;
    delete process.env.JEV_DECISIONS_URL;
    let request;
    const fetchImpl = async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: "resolved", answers: {} }) };
    };
    try {
      await jevDecide("state", { pass: { type: "noul", instructions: "pass?" } }, {
        apiKey: "k",
        fetchImpl,
        models: { jev: { defaultModel: "override-jev", decisionsUrl: "https://example.test/decisions" } },
      });
      assert.equal(request.url, "https://example.test/decisions");
      assert.equal(request.body.model, "override-jev");
    } finally {
      if (previousModel == null) delete process.env.JEV_MODEL;
      else process.env.JEV_MODEL = previousModel;
      if (previousUrl == null) delete process.env.JEV_DECISIONS_URL;
      else process.env.JEV_DECISIONS_URL = previousUrl;
    }
  });
});

describe("buildJevJudgeState / questions", () => {
  it("includes source, candidate, BT, locale, key, glossary notes", () => {
    const state = buildJevJudgeState({
      source: "Play",
      candidate: "הפעלה",
      backtranslation: "Activation",
      locale: "he",
      key: "ui.timeline.play",
      glossary: {
        schemaVersion: "0",
        locale: "he",
        entries: [
          {
            source: "Play",
            locale: "he",
            productMeaning: "timeline transport",
            relatedTerms: [],
            practitionerTerm: "נגן",
            approved: true,
            rejected: [{ term: "שחק", why: "game sense" }],
          },
        ],
      },
    });
    assert.equal(state.locale, "he");
    assert.equal(state.en, "Play");
    assert.equal(state.candidate, "הפעלה");
    assert.equal(state.backtranslation, "Activation");
    assert.equal(state.key, "ui.timeline.play");
    assert.match(state.glossary_notes, /Play/);
    const q = buildJevJudgeQuestions();
    assert.equal(q.escalate.type, "noul");
    assert.equal(q.meaning_ok.type, "noul");
    assert.equal(q.glossary_ok.type, "noul");
    assert.equal(q.quality.type, "score");
    assert.equal(q.quality.criteria.length, 3);
    assert.equal(q.register_ok.type, "noul");
    assert.equal(q.ui_role_ok.type, "noul");
  });

  it("passes icu and role hints into state when provided", () => {
    const state = buildJevJudgeState({
      source: "Play",
      candidate: "הפעלה",
      backtranslation: "Activation",
      locale: "he",
      key: "ui.timeline.play",
      icuOk: true,
      ui_role: "button_imperative",
      register: "neutral_ui",
    });
    assert.equal(state.icuOk, true);
    assert.equal(state.ui_role, "button_imperative");
    assert.equal(state.register, "neutral_ui");
  });

  it("pins default model to typesafe/jev-1.13 (not ~jev-latest)", () => {
    assert.equal(JEV_DEFAULT_MODEL, "typesafe/jev-1.13");
    assert.ok(!JEV_DEFAULT_MODEL.includes("~"));
    assert.ok(!JEV_DEFAULT_MODEL.includes("latest"));
  });

  it("lean state only includes keys questions need", () => {
    const state = buildJevJudgeState({
      source: "Play",
      candidate: "再生",
      backtranslation: "Playback",
      locale: "ja",
      key: "ui.timeline.play",
      icuOk: false,
      icuMissing: ["count"],
      ui_role: "button_imperative",
      // accidental extras must not leak
      rationale: "LONG CODEX RATIONALE " + "x".repeat(200),
      scores: { meaning: 0.9 },
      unused_blob: { a: 1 },
    });
    const keys = Object.keys(state).sort();
    for (const k of keys) {
      assert.ok(
        JEV_LEAN_STATE_KEYS.includes(k),
        `unexpected lean state key: ${k}`,
      );
    }
    assert.ok(!("rationale" in state));
    assert.ok(!("scores" in state));
    assert.ok(!("unused_blob" in state));
    assert.deepEqual(
      keys.filter((k) => k !== "product").sort(),
      [
        "backtranslation",
        "candidate",
        "en",
        "icuMissing",
        "icuOk",
        "key",
        "locale",
        "ui_role",
      ].sort(),
    );
  });
});

describe("mapJevAnswersToJudge", () => {
  const sampleAnswers = {
    escalate: { type: "noul", noul: 0.91 },
    meaning_ok: { type: "noul", noul: 0.22 },
    glossary_ok: { type: "noul", noul: 0.36 },
    quality: {
      type: "score",
      score: 0.88,
      confidence: 0.78,
    },
  };

  it("maps sample answers and escalates on low meaning", () => {
    const j = mapJevAnswersToJudge(sampleAnswers, {
      key: "ui.status.rendering",
      model: "typesafe/jev-1.13-20260917",
      usage: { input_tokens: 10, output_tokens: 5, cost: 1e-5 },
    });
    assert.equal(j.provider, JEV_PROVIDER_ID);
    assert.equal(j.key, "ui.status.rendering");
    assert.equal(j.meaning, 0.22);
    assert.equal(j.glossaryOk, false); // 0.36 < 0.5
    assert.equal(j.escalate, true);
    assert.ok(j.meaning < JEV_MEANING_THRESHOLD);
    assert.match(j.rationale, /escalate=0\.91/);
    assert.match(j.rationale, /meaning_ok=0\.22/);
    assert.equal(j.model, "typesafe/jev-1.13-20260917");
    assert.equal(j.usage.cost, 1e-5);
    assert.ok(j.fluency >= 0 && j.fluency <= 1);
  });

  it("accepts high meaning_ok when escalate noul low and glossary ok", () => {
    const j = mapJevAnswersToJudge({
      escalate: { type: "noul", noul: 0.1 },
      meaning_ok: { type: "noul", noul: 0.94 },
      glossary_ok: { type: "noul", noul: 0.84 },
      quality: { type: "score", score: 1.82, confidence: 0.72 },
    });
    assert.equal(j.escalate, false);
    assert.equal(j.glossaryOk, true);
    assert.equal(j.meaning, 0.94);
  });

  it("escalates when escalate.noul >= 0.5 even if meaning high", () => {
    const j = mapJevAnswersToJudge({
      escalate: { type: "noul", noul: 0.65 },
      meaning_ok: { type: "noul", noul: 0.83 },
      glossary_ok: { type: "noul", noul: 0.86 },
      quality: { type: "score", score: 1.0 },
    });
    assert.equal(j.escalate, true);
  });

  it("soft-escalates when ui_role_ok is low even if meaning high", () => {
    const j = mapJevAnswersToJudge({
      escalate: { type: "noul", noul: 0.2 },
      meaning_ok: { type: "noul", noul: 0.9 },
      glossary_ok: { type: "noul", noul: 0.9 },
      quality: { type: "score", score: 1.8 },
      register_ok: { type: "noul", noul: 0.8 },
      ui_role_ok: { type: "noul", noul: 0.19 },
    });
    assert.equal(j.escalate, true);
    assert.equal(j.uiRoleOk, false);
    assert.equal(j.registerOk, true);
    assert.match(j.rationale, /ui_role_ok=0\.19/);
  });

  it("ignores missing register_ok / ui_role_ok (backward compatible)", () => {
    const j = mapJevAnswersToJudge({
      escalate: { type: "noul", noul: 0.1 },
      meaning_ok: { type: "noul", noul: 0.94 },
      glossary_ok: { type: "noul", noul: 0.84 },
      quality: { type: "score", score: 1.82 },
    });
    assert.equal(j.escalate, false);
    assert.equal(j.registerOk, undefined);
    assert.equal(j.uiRoleOk, undefined);
  });

  it("escalates when answer confidence < floor even if noul looks ok", () => {
    assert.equal(JEV_CONFIDENCE_FLOOR, 0.5);
    const j = mapJevAnswersToJudge({
      escalate: { type: "noul", noul: 0.1, confidence: 0.3 },
      meaning_ok: { type: "noul", noul: 0.94 },
      glossary_ok: { type: "noul", noul: 0.9 },
      quality: { type: "score", score: 1.8, confidence: 0.8 },
    });
    assert.equal(j.escalate, true);
    assert.equal(j.confidenceUnsure, true);
    assert.match(j.rationale, /confidence_unsure=true/);
  });

  it("escalates on low quality confidence (overall uncertain)", () => {
    const j = mapJevAnswersToJudge({
      escalate: { type: "noul", noul: 0.1 },
      meaning_ok: { type: "noul", noul: 0.9 },
      glossary_ok: { type: "noul", noul: 0.9 },
      quality: { type: "score", score: 1.7, confidence: 0.27 },
      register_ok: { type: "noul", noul: 0.8 },
      ui_role_ok: { type: "noul", noul: 0.8 },
    });
    assert.equal(jevConfidenceUnsure({
      quality: { confidence: 0.27 },
    }), true);
    assert.equal(j.escalate, true);
    assert.equal(j.confidenceUnsure, true);
  });

  it("does not treat missing confidence as unsure", () => {
    const j = mapJevAnswersToJudge({
      escalate: { type: "noul", noul: 0.1 },
      meaning_ok: { type: "noul", noul: 0.94 },
      glossary_ok: { type: "noul", noul: 0.84 },
      quality: { type: "score", score: 1.82 },
    });
    assert.equal(j.escalate, false);
    assert.equal(j.confidenceUnsure, undefined);
  });

  it("always returns model (default pin when omitted)", () => {
    const j = mapJevAnswersToJudge({
      escalate: { type: "noul", noul: 0.1 },
      meaning_ok: { type: "noul", noul: 0.94 },
      glossary_ok: { type: "noul", noul: 0.84 },
      quality: { type: "score", score: 1.82 },
    });
    assert.equal(j.model, JEV_DEFAULT_MODEL);
  });

  it("fails closed on non-number nouls (no coercion of true / strings)", () => {
    assert.throws(
      () =>
        mapJevAnswersToJudge({
          escalate: { noul: 0.1 },
          meaning_ok: { noul: true },
          glossary_ok: { noul: 0.9 },
          quality: { score: 1.5 },
        }),
      /meaning_ok/,
    );
    assert.throws(
      () =>
        mapJevAnswersToJudge({
          escalate: { noul: "0" },
          meaning_ok: { noul: 0.9 },
          glossary_ok: { noul: 0.9 },
          quality: { score: 1.5 },
        }),
      /escalate/,
    );
  });

  it("fails closed on missing noul fields", () => {
    assert.throws(
      () => mapJevAnswersToJudge({ escalate: { noul: 0.1 } }),
      /meaning_ok/,
    );
  });
});

describe("resolveOpenRouterApiKey", () => {
  it("reads the key from the environment", () => {
    const k = resolveOpenRouterApiKey({
      env: { OPENROUTER_API_KEY: " from-env " },
      allowSecretsFile: false,
    });
    assert.equal(k, "from-env");
  });

  it("returns null when the key is missing", () => {
    assert.equal(
      resolveOpenRouterApiKey({ env: {}, allowSecretsFile: false }),
      null,
    );
  });
});

describe("jevDecide / jevOpenRouterJudge (mocked fetch)", () => {
  it("jevDecide posts Decisions body and returns JSON", async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            model: "typesafe/jev-1.13-test",
            answers: { ping: { type: "noul", noul: 0.7 } },
            usage: { cost: 0 },
          }),
      };
    };
    const out = await jevDecide(
      { hello: "world" },
      { ping: { type: "noul", instructions: "ok?" } },
      { fetchImpl, apiKey: "test-key" },
    );
    assert.equal(seen.url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(seen.init.method, "POST");
    assert.match(seen.init.headers.Authorization, /^Bearer test-key$/);
    const body = JSON.parse(seen.init.body);
    assert.equal(body.state.hello, "world");
    assert.equal(body.questions.ping.type, "noul");
    assert.equal(out.answers.ping.noul, 0.7);
  });

  it("jevOpenRouterJudge maps mocked Decisions response", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: "typesafe/jev-1.13-test",
          answers: {
            escalate: { type: "noul", noul: 0.12 },
            meaning_ok: { type: "noul", noul: 0.9 },
            glossary_ok: { type: "noul", noul: 0.88 },
            quality: { type: "score", score: 1.7, confidence: 0.8 },
            register_ok: { type: "noul", noul: 0.91 },
            ui_role_ok: { type: "noul", noul: 0.87 },
          },
          usage: { input_tokens: 100, output_tokens: 20, cost: 0.0001 },
        }),
    });
    const j = await jevOpenRouterJudge(
      {
        source: "Pause",
        candidate: "השהה",
        backtranslation: "Pause",
        locale: "he",
        key: "ui.timeline.pause",
      },
      { fetchImpl, apiKey: "test-key" },
    );
    assert.equal(j.provider, "api:jev");
    assert.equal(j.escalate, false);
    assert.equal(j.meaning, 0.9);
    assert.equal(j.glossaryOk, true);
    assert.equal(j.uiRoleOk, true);
    assert.equal(j.registerOk, true);
    assert.equal(j.model, "typesafe/jev-1.13-test");
  });

  it("jevDecide times out instead of hanging", async () => {
    const prev = process.env.OPENROUTER_TIMEOUT_MS;
    process.env.OPENROUTER_TIMEOUT_MS = "30";
    try {
      const fetchImpl = (url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      await assert.rejects(
        () => jevDecide({ a: 1 }, { q: { type: "noul", instructions: "?" } }, { fetchImpl, apiKey: "k" }),
        /timed out after 30ms/,
      );
    } finally {
      if (prev == null) delete process.env.OPENROUTER_TIMEOUT_MS;
      else process.env.OPENROUTER_TIMEOUT_MS = prev;
    }
  });

  it("errors clearly when API key missing", async () => {
    await assert.rejects(
      () =>
        jevOpenRouterJudge(
          { source: "a", candidate: "b", backtranslation: "c" },
          { apiKey: null, fetchImpl: async () => ({}) },
        ),
      /OPENROUTER_API_KEY/,
    );
  });
});
