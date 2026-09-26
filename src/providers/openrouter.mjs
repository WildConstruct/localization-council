/**
 * OpenRouter provider: every stage over one OPENROUTER_API_KEY.
 *
 * Spec: openrouter:<vendor>/<model> (any OpenRouter model slug).
 * Plain "openrouter" in a profile or stage map resolves to the stage default
 * in config/models.json (openrouter.stages).
 *
 * Each call:
 *   - batches items (config/models.json openrouter.batchSize per stage)
 *   - asks for JSON output (json_schema structured output by default)
 *   - validates the reply against schemas/ and retries on bad output
 *   - retries 408/429/5xx/network/timeouts with exponential backoff
 *     (honors Retry-After), then falls back to single-item calls
 *   - records response.model and usage.cost via ctx.telemetry
 *
 * Env (all optional except the key):
 *   OPENROUTER_API_KEY       required
 *   OPENROUTER_BASE_URL      default from config/models.json (useful for proxies/tests)
 *   OPENROUTER_TIMEOUT_MS    per-request timeout
 *   OPENROUTER_MAX_RETRIES   retries per request
 *   OPENROUTER_BATCH_SIZE    override items per request for every stage
 */

import { loadModelsConfig } from "../config.mjs";
import { loadSchema, validate } from "../json-schema.mjs";
import { glossaryPromptBlock } from "../glossary.mjs";
import { familyOf } from "./families.mjs";
import { chunk, MissingVerdictError } from "./contract.mjs";
import { validateJudgeParsed } from "./judge-schema.mjs";
import { BATCH_SYSTEM, PROMPT_VERSION } from "./prompts.mjs";

const ITEM_SCHEMA_FILE = {
  translate: "translation.v1.json",
  backtranslate: "backtranslation.v1.json",
  judge: "judge-verdict.v1.json",
  compare: "compare-verdict.v1.json",
};

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const VALIDATION_KEYWORDS = new Set(["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "pattern", "format"]);

/** Read OPENROUTER_API_KEY from the environment. Never logged. */
export function resolveOpenRouterApiKey(env = process.env) {
  const k = env.OPENROUTER_API_KEY;
  return typeof k === "string" && k.trim() ? k.trim() : null;
}

/** { items: [{ key, ...item }] } batch schema for a stage (full, for local validation). */
export function batchSchema(stage) {
  const item = loadSchema(ITEM_SCHEMA_FILE[stage]);
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", ...item.required],
          properties: { key: { type: "string" }, ...item.properties },
        },
      },
    },
  };
}

/** Schema sent to the provider: validation keywords stripped (not every backend accepts them). */
export function wireSchema(schema) {
  if (Array.isArray(schema)) return schema.map(wireSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (VALIDATION_KEYWORDS.has(k) || k === "$schema" || k === "$id" || k === "title" || k === "description") continue;
    out[k] = typeof v === "object" ? wireSchema(v) : v;
  }
  return out;
}

/** Pull JSON out of a chat message (strips ``` fences; joins content parts). */
export function parseMessageJson(message) {
  let content = message?.content;
  if (Array.isArray(content)) {
    content = content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  }
  if (content && typeof content === "object") return content;
  const text = String(content ?? "").trim();
  if (!text) throw new Error("empty message content");
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1] : text;
  try {
    return JSON.parse(body);
  } catch {
    const m = body.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`non-JSON content: ${body.slice(0, 200)}`);
    return JSON.parse(m[0]);
  }
}

/** API base URL without trailing slashes (a loop, not a regex: the value comes from env/config). */
function resolveBaseUrl(cfg) {
  let url = process.env.OPENROUTER_BASE_URL || cfg?.baseUrl || "https://openrouter.ai/api/v1";
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

function numEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

class HttpError extends Error {
  constructor(status, message, retryAfterMs = null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function remedy(status) {
  if (status === 401) return " (check OPENROUTER_API_KEY)";
  if (status === 402) return " (the OpenRouter account needs credits)";
  if (status === 400 || status === 404) {
    return " (the model slug may be wrong or retired: check config/models.json, or run `council doctor --online`)";
  }
  return "";
}

/**
 * Create an OpenRouter adapter for one model slug.
 * @param {string} slug
 * @param {{ models?: object, fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>, apiKey?: string }} [opts]
 */
export function createOpenRouterAdapter(slug, opts = {}) {
  if (!slug || typeof slug !== "string") throw new Error("openrouter: model slug required (openrouter:<vendor>/<model>)");
  const models = opts.models || loadModelsConfig();
  const cfg = models.openrouter || {};
  const id = `openrouter:${slug}`;
  const family = familyOf(id);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const baseUrl = resolveBaseUrl(cfg);
  const timeoutMs = numEnv("OPENROUTER_TIMEOUT_MS", cfg.timeoutMs ?? 120_000);
  const maxRetries = numEnv("OPENROUTER_MAX_RETRIES", cfg.maxRetries ?? 3);
  const structured = cfg.structuredOutput || "json_schema";

  function apiKey() {
    const k = opts.apiKey ?? resolveOpenRouterApiKey();
    if (!k) {
      throw new Error(`${id}: set OPENROUTER_API_KEY (or use --profile=fleet / --profile=mock). Run \`council doctor\` to check.`);
    }
    return k;
  }

  async function post(body) {
    const key = apiKey();
    const controller = new AbortController();
    // The timeout covers the whole exchange, including reading the body.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/WildConstruct/localization-council",
          "X-Title": "Localization Council",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const aborted = err?.name === "AbortError" || controller.signal.aborted;
      throw new HttpError(0, aborted ? `request timed out after ${timeoutMs}ms` : `network error: ${err?.message || err}`);
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* handled below */
    }
    if (!res.ok) {
      const raHeader = res.headers?.get?.("retry-after");
      const ra = raHeader == null || raHeader === "" ? NaN : Number(raHeader);
      const msg = json?.error?.message || json?.message || text.slice(0, 300);
      throw new HttpError(res.status, `HTTP ${res.status}: ${msg}`, Number.isFinite(ra) && ra >= 0 ? Math.min(ra, 60) * 1000 : null);
    }
    if (!json) throw new HttpError(502, `non-JSON response body: ${text.slice(0, 200)}`);
    if (json.error) {
      const code = Number(json.error.code) || 502;
      throw new HttpError(code, `upstream error: ${json.error.message || JSON.stringify(json.error).slice(0, 200)}`);
    }
    return json;
  }

  /**
   * One request with retries. Returns { items, model, usage }.
   * Bad JSON / schema failures are retried like transient errors.
   */
  async function callStage(stage, payload, ctx) {
    const schema = batchSchema(stage);
    const body = {
      model: slug,
      messages: [
        { role: "system", content: BATCH_SYSTEM[stage] },
        { role: "user", content: JSON.stringify(payload) },
      ],
      temperature: 0,
      usage: { include: true },
      response_format:
        structured === "json_schema"
          ? { type: "json_schema", json_schema: { name: `council_${stage}`, strict: true, schema: wireSchema(schema) } }
          : { type: "json_object" },
    };
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const started = Date.now();
      try {
        const json = await post(body);
        const telemetry = {
          stage,
          provider: id,
          requestedModel: slug,
          resolvedModel: json.model || null,
          costUsd: Number.isFinite(Number(json.usage?.cost)) ? Number(json.usage.cost) : null,
          inputTokens: json.usage?.prompt_tokens ?? null,
          outputTokens: json.usage?.completion_tokens ?? null,
          ms: Date.now() - started,
          retries: attempt,
        };
        let parsed;
        try {
          parsed = parseMessageJson(json.choices?.[0]?.message);
        } catch (err) {
          ctx?.telemetry?.record({ ...telemetry, ok: false, invalid: true });
          throw new HttpError(-1, `unparseable reply: ${err.message}`);
        }
        const { ok, errors } = validate(parsed, schema);
        if (!ok) {
          ctx?.telemetry?.record({ ...telemetry, ok: false, invalid: true });
          throw new HttpError(-1, `reply failed schema: ${errors.slice(0, 3).join("; ")}`);
        }
        ctx?.telemetry?.record({ ...telemetry, ok: true });
        return { items: parsed.items, model: json.model || slug };
      } catch (err) {
        lastErr = err;
        const status = err instanceof HttpError ? err.status : -1;
        // Only transport/HTTP/bad-output errors retry; config errors (no key) fail at once.
        const retryable = err instanceof HttpError && (status === 0 || status === -1 || RETRYABLE_STATUS.has(status));
        if (!retryable || attempt === maxRetries) break;
        const backoff = err.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
        ctx?.log?.(`[${id}] ${stage} attempt ${attempt + 1} failed (${err.message}); retrying in ${backoff}ms`);
        await sleep(backoff);
      }
    }
    const status = lastErr instanceof HttpError ? lastErr.status : null;
    const e = new Error(`${id} ${stage} failed: ${lastErr?.message || lastErr}${status > 0 ? remedy(status) : ""}`);
    e.status = status;
    throw e;
  }

  function payloadFor(stage, batch, items) {
    const glossary = batch.glossary ? glossaryPromptBlock(batch.glossary) || undefined : undefined;
    if (stage === "translate") {
      return { locale: batch.locale, glossary, items: items.map(({ key, source }) => ({ key, source })) };
    }
    if (stage === "backtranslate") {
      return { locale: batch.locale, items: items.map(({ key, candidate }) => ({ key, candidate })) };
    }
    if (stage === "judge") {
      return {
        locale: batch.locale,
        glossary,
        items: items.map(({ key, source, candidate, backtranslation }) => ({ key, source, candidate, backtranslation })),
      };
    }
    return {
      locale: batch.locale,
      glossary,
      items: items.map(({ key, source, options }) => ({ key, source, options })),
    };
  }

  /** Map validated reply items to adapter rows; returns Map<key,row> of usable rows. */
  function toRows(stage, batch, items, replyItems, model) {
    const wanted = new Map(items.map((it) => [it.key, it]));
    const rows = new Map();
    for (const r of replyItems) {
      const it = wanted.get(r.key);
      if (!it || rows.has(r.key)) continue;
      if (stage === "translate") rows.set(r.key, { key: r.key, candidate: r.translation, model });
      else if (stage === "backtranslate") rows.set(r.key, { key: r.key, backtranslation: r.backtranslation, model });
      else if (stage === "judge") {
        const v = validateJudgeParsed(r, { provider: id, key: r.key, glossary: batch.glossary });
        rows.set(r.key, { ...v, model });
      } else {
        const labels = Object.keys(it.options || {});
        if (r.pick !== "none" && !labels.includes(r.pick)) continue; // treated as missing → single retry
        rows.set(r.key, { key: r.key, pick: r.pick, rationale: r.rationale, model });
      }
    }
    return rows;
  }

  async function runStage(stage, batch, ctx) {
    apiKey(); // fail fast, before any retry loop
    if (stage === "backtranslate") {
      // Catalog keys can carry the English source (page-wrapper catalogs use the
      // English string as the key; dotted keys hint at meaning). The blind
      // back-translator gets opaque ids instead and never sees the keys.
      const ids = batch.items.map((_, i) => `c${i}`);
      let rows;
      try {
        rows = await runStageItems(stage, { ...batch, items: batch.items.map((it, i) => ({ ...it, key: ids[i] })) }, ctx);
      } catch (err) {
        if (err instanceof MissingVerdictError) {
          const real = batch.items[ids.indexOf(err.key)]?.key ?? err.key;
          throw new MissingVerdictError(id, stage, real, err.message.split(": ").slice(1).join(": "));
        }
        throw err;
      }
      return rows.map((r, i) => ({ ...r, key: batch.items[i].key }));
    }
    return runStageItems(stage, batch, ctx);
  }

  async function runStageItems(stage, batch, ctx) {
    const size = numEnv("OPENROUTER_BATCH_SIZE", 0) || cfg.batchSize?.[stage] || 10;
    const out = [];
    for (const group of chunk(batch.items, size)) {
      let rows = new Map();
      try {
        const reply = await callStage(stage, payloadFor(stage, batch, group), ctx);
        rows = toRows(stage, batch, group, reply.items, reply.model);
      } catch (err) {
        // Only malformed replies fall back to single items; HTTP/auth/model errors surface as-is.
        if (group.length === 1 || err.status !== -1) throw err;
        ctx?.log?.(`[${id}] ${stage} batch of ${group.length} failed (${err.message}); falling back to single items`);
      }
      for (const it of group) {
        if (!rows.has(it.key)) {
          const reply = await callStage(stage, payloadFor(stage, batch, [it]), ctx);
          const single = toRows(stage, batch, [it], reply.items, reply.model);
          if (!single.has(it.key)) throw new MissingVerdictError(id, stage, it.key, "no usable item in reply");
          rows.set(it.key, single.get(it.key));
        }
        out.push(rows.get(it.key));
      }
    }
    return out;
  }

  return {
    id,
    family,
    slug,
    describe(stage) {
      return { provider: id, model: slug, family, promptVersion: `openrouter/${stage}@${PROMPT_VERSION[stage]}` };
    },
    batchSize(stage) {
      return numEnv("OPENROUTER_BATCH_SIZE", 0) || cfg.batchSize?.[stage] || 10;
    },
    translate: (batch, ctx) => runStage("translate", batch, ctx),
    backtranslate: (batch, ctx) => runStage("backtranslate", batch, ctx),
    judge: (batch, ctx) => runStage("judge", batch, ctx),
    compare: (batch, ctx) => runStage("compare", batch, ctx),
  };
}

/**
 * Check which slugs exist on OpenRouter (public model list, no key needed).
 * @returns {Promise<{ reachable: boolean, error?: string, models: Record<string, boolean> }>}
 */
export async function checkOpenRouterModels(slugs, { fetchImpl = globalThis.fetch, models = loadModelsConfig(), timeoutMs = 15_000 } = {}) {
  const baseUrl = resolveBaseUrl(models.openrouter);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/models`, { signal: controller.signal });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}`, models: {} };
    const json = await res.json();
    const ids = new Set((json.data || []).map((m) => m.id));
    return {
      reachable: true,
      models: Object.fromEntries(slugs.map((s) => [s, ids.has(s.replace(/^~/, "")) || ids.has(s)])),
    };
  } catch (err) {
    return { reachable: false, error: err?.name === "AbortError" ? "timeout" : String(err?.message || err), models: {} };
  } finally {
    clearTimeout(timer);
  }
}
