import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createOpenRouterAdapter,
  batchSchema,
  wireSchema,
  parseMessageJson,
  checkOpenRouterModels,
} from "../src/providers/openrouter.mjs";
import { Telemetry } from "../src/run-context.mjs";
import { answerChat } from "./helpers/fake-openrouter.mjs";

const SLUG = "anthropic/claude-opus-5.5";
const BATCH = {
  locale: "de",
  glossary: null,
  items: [
    { key: "a", source: "Play" },
    { key: "b", source: "Pause" },
    { key: "c", source: "Duration" },
  ],
};

function res(status, json, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    text: async () => (typeof json === "string" ? json : JSON.stringify(json)),
  };
}

/** fetch backed by the fake server's answer logic, with optional per-call overrides. */
function scriptedFetch(script = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const step = script[calls.length - 1];
    if (typeof step === "function") return step(body);
    return res(200, answerChat(body));
  };
  return { fetchImpl, calls };
}

function adapter(fetchImpl, extra = {}) {
  return createOpenRouterAdapter(SLUG, { fetchImpl, sleep: async () => {}, apiKey: "k", ...extra });
}

describe("openrouter request shape", () => {
  it("sends the model slug, JSON schema output, usage accounting, and auth", async () => {
    const { fetchImpl, calls } = scriptedFetch();
    const ctx = { telemetry: new Telemetry(), log() {} };
    const rows = await adapter(fetchImpl).translate(BATCH, ctx);
    assert.deepEqual(rows.map((r) => r.candidate), ["Abspielen", "Pause", "Dauer"]);
    const { url, init, body } = calls[0];
    assert.match(url, /\/chat\/completions$/);
    assert.equal(init.headers.Authorization, "Bearer k");
    assert.equal(body.model, SLUG);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.name, "council_translate");
    assert.equal(body.usage.include, true);
    const payload = JSON.parse(body.messages[1].content);
    assert.deepEqual(payload.items.map((i) => i.key), ["a", "b", "c"]);

    const t = ctx.telemetry.summary();
    assert.deepEqual(t.byStage.translate.resolvedModels, [`${SLUG}-20260901`]);
    assert.equal(t.costUsd, 0.0005);
  });

  it("back-translation payload never contains the source, not even via the key", async () => {
    const { fetchImpl, calls } = scriptedFetch();
    // Page-wrapper catalogs use the English string as the key.
    const rows = await adapter(fetchImpl).backtranslate(
      { locale: "de", items: [{ key: "Skip to content", candidate: "Zum Inhalt springen" }, { key: "Play", candidate: "Abspielen" }] },
      {},
    );
    const payload = JSON.parse(calls[0].body.messages[1].content);
    assert.deepEqual(Object.keys(payload.items[0]).sort(), ["candidate", "key"]);
    assert.deepEqual(payload.items.map((i) => i.key), ["c0", "c1"]);
    assert.doesNotMatch(calls[0].body.messages[1].content, /Skip to content|"Play"/);
    assert.deepEqual(rows.map((r) => r.key), ["Skip to content", "Play"], "rows map back to the real keys");
  });

  it("batches by config batch size", async () => {
    const { fetchImpl, calls } = scriptedFetch();
    const models = { openrouter: { batchSize: { translate: 2 }, maxRetries: 0 } };
    await adapter(fetchImpl, { models }).translate(BATCH, {});
    assert.equal(calls.length, 2);
  });

  it("wire schema drops validation keywords the local validator still enforces", () => {
    const full = batchSchema("judge");
    const wire = wireSchema(full);
    assert.equal(full.properties.items.items.properties.meaning.maximum, 1);
    assert.equal(wire.properties.items.items.properties.meaning.maximum, undefined);
    assert.deepEqual(wire.properties.items.items.required, full.properties.items.items.required);
  });

  it("parses fenced or part-array message content", () => {
    assert.deepEqual(parseMessageJson({ content: '```json\n{"items":[]}\n```' }), { items: [] });
    assert.deepEqual(parseMessageJson({ content: [{ type: "text", text: '{"items":[]}' }] }), { items: [] });
    assert.throws(() => parseMessageJson({ content: "" }), /empty/);
  });
});

describe("openrouter retries and errors", () => {
  it("retries 429 and 5xx with backoff, honoring Retry-After", async () => {
    const waits = [];
    const { fetchImpl, calls } = scriptedFetch([
      () => res(429, { error: { message: "rate limited" } }, { "retry-after": "2" }),
      () => res(503, { error: { message: "overloaded" } }),
    ]);
    const a = createOpenRouterAdapter(SLUG, { fetchImpl, apiKey: "k", sleep: async (ms) => waits.push(ms) });
    const rows = await a.translate(BATCH, {});
    assert.equal(rows.length, 3);
    assert.equal(calls.length, 3);
    assert.equal(waits[0], 2000);
    assert.ok(waits[1] >= 2000 && waits[1] < 2300, `exponential backoff, got ${waits[1]}`);
  });

  it("does not retry 401 and says what to fix", async () => {
    const { fetchImpl, calls } = scriptedFetch([() => res(401, { error: { message: "No auth credentials found" } })]);
    await assert.rejects(() => adapter(fetchImpl).translate(BATCH, {}), /HTTP 401.*check OPENROUTER_API_KEY/);
    assert.equal(calls.length, 1);
  });

  it("points at config/models.json when the model slug is rejected", async () => {
    const { fetchImpl } = scriptedFetch([() => res(400, { error: { message: "x is not a valid model ID" } })]);
    await assert.rejects(() => adapter(fetchImpl).translate(BATCH, {}), /config\/models\.json/);
  });

  it("gives up after maxRetries on persistent 5xx", async () => {
    const { fetchImpl, calls } = scriptedFetch(Array(10).fill(() => res(502, { error: { message: "bad gateway" } })));
    await assert.rejects(() => adapter(fetchImpl, { models: { openrouter: { maxRetries: 2 } } }).translate(BATCH, {}), /HTTP 502/);
    assert.equal(calls.length, 3);
  });

  it("treats a timeout as retryable", async () => {
    let n = 0;
    const fetchImpl = async (url, init) => {
      n += 1;
      if (n === 1) {
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      }
      return res(200, answerChat(JSON.parse(init.body)));
    };
    const a = createOpenRouterAdapter(SLUG, {
      fetchImpl,
      apiKey: "k",
      sleep: async () => {},
      models: { openrouter: { timeoutMs: 20, maxRetries: 1 } },
    });
    const rows = await a.translate({ locale: "de", items: [{ key: "a", source: "Play" }] }, {});
    assert.equal(rows[0].candidate, "Abspielen");
    assert.equal(n, 2);
  });

  it("the timeout covers a response whose body stalls, and the retry recovers", async () => {
    let n = 0;
    const fetchImpl = async (url, init) => {
      n += 1;
      const body = JSON.parse(init.body);
      if (n === 1) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: () =>
            new Promise((_, reject) => {
              init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
            }),
        };
      }
      return res(200, answerChat(body));
    };
    const a = createOpenRouterAdapter(SLUG, {
      fetchImpl,
      apiKey: "k",
      sleep: async () => {},
      models: { openrouter: { timeoutMs: 30, maxRetries: 1 } },
    });
    const rows = await a.translate({ locale: "de", items: [{ key: "a", source: "Play" }] }, {});
    assert.equal(rows[0].candidate, "Abspielen");
    assert.equal(n, 2);
  });

  it("a connection reset while reading the body is retried", async () => {
    let n = 0;
    const fetchImpl = async (url, init) => {
      n += 1;
      if (n === 1) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => { throw new TypeError("terminated"); } };
      }
      return res(200, answerChat(JSON.parse(init.body)));
    };
    const rows = await adapter(fetchImpl).translate({ locale: "de", items: [{ key: "a", source: "Play" }] }, {});
    assert.equal(rows[0].candidate, "Abspielen");
    assert.equal(n, 2);
  });

  it("retries a reply that fails the schema, then falls back to single items", async () => {
    const bad = () => res(200, { model: SLUG, choices: [{ message: { content: '{"items":[{"key":"a"}]}' } }], usage: {} });
    const { fetchImpl, calls } = scriptedFetch([bad, bad]);
    const rows = await adapter(fetchImpl, { models: { openrouter: { maxRetries: 1 } } }).translate(BATCH, {});
    assert.deepEqual(rows.map((r) => r.key), ["a", "b", "c"]);
    // 2 failed batch attempts + 3 singles
    assert.equal(calls.length, 5);
    assert.equal(JSON.parse(calls[2].body.messages[1].content).items.length, 1);
  });

  it("records cost for invalid HTTP-success replies without counting them as successful calls", async () => {
    const bad = () => res(200, {
      model: `${SLUG}-bad`,
      choices: [{ message: { content: '{"items":[{"key":"a"}]}' } }],
      usage: { cost: 0.002 },
    });
    const { fetchImpl } = scriptedFetch([bad]);
    const ctx = { telemetry: new Telemetry(), log() {} };
    await adapter(fetchImpl, { models: { openrouter: { maxRetries: 1 } } }).translate(BATCH, ctx);
    const t = ctx.telemetry.summary();
    assert.equal(t.costUsd, 0.0025);
    assert.equal(t.costComplete, true);
    assert.equal(t.calls, 1);
    assert.equal(t.byStage.translate.calls, 1);
  });

  it("re-asks singly for keys a batch reply left out", async () => {
    const partial = (body) => {
      const full = answerChat(body);
      const parsed = JSON.parse(full.choices[0].message.content);
      parsed.items = parsed.items.filter((i) => i.key !== "b");
      full.choices[0].message.content = JSON.stringify(parsed);
      return res(200, full);
    };
    const { fetchImpl, calls } = scriptedFetch([partial]);
    const rows = await adapter(fetchImpl).translate(BATCH, {});
    assert.equal(rows.find((r) => r.key === "b").candidate, "Pause");
    assert.equal(calls.length, 2);
  });

  it("compare picks outside the labels are re-asked, then fail as missing verdicts", async () => {
    const badPick = (body) => {
      const payload = JSON.parse(body.messages[1].content);
      const items = payload.items.map((i) => ({ key: i.key, pick: "Q", rationale: "" }));
      return res(200, { model: SLUG, choices: [{ message: { content: JSON.stringify({ items }) } }], usage: {} });
    };
    const { fetchImpl } = scriptedFetch([badPick, badPick]);
    await assert.rejects(
      () =>
        adapter(fetchImpl).compare(
          { locale: "de", items: [{ key: "r", source: "Rendering…", options: { X: "a", Y: "b" } }] },
          {},
        ),
      /no compare verdict/,
    );
  });

  it("fails before any request when OPENROUTER_API_KEY is missing", async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const { fetchImpl, calls } = scriptedFetch();
      const a = createOpenRouterAdapter(SLUG, { fetchImpl, sleep: async () => {} });
      await assert.rejects(() => a.translate(BATCH, {}), /set OPENROUTER_API_KEY/);
      assert.equal(calls.length, 0);
    } finally {
      if (prev != null) process.env.OPENROUTER_API_KEY = prev;
    }
  });
});

describe("checkOpenRouterModels", () => {
  it("reports which slugs exist", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: SLUG }] }) });
    const r = await checkOpenRouterModels([SLUG, "x-ai/nope"], { fetchImpl });
    assert.equal(r.reachable, true);
    assert.deepEqual(r.models, { [SLUG]: true, "x-ai/nope": false });
  });

  it("reports unreachable without throwing", async () => {
    const r = await checkOpenRouterModels([SLUG], {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    assert.equal(r.reachable, false);
  });
});
