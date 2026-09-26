/**
 * Local stand-in for the OpenRouter API (node:http on 127.0.0.1).
 * Answers chat completions like the mock providers, keyed by model vendor:
 *   anthropic/* → mock, openai/* → mock:alt, x-ai/* → mock:third
 * Point the council at it with OPENROUTER_BASE_URL=<url>.
 */
import { createServer } from "node:http";
import {
  mockTranslateText,
  mockBacktranslateText,
  mockJudgeOne,
  mockCompareOne,
} from "../../src/providers/mock.mjs";
import { parseGlossaryBlock } from "../fixtures/fake-cli-lib.mjs";

const VARIANT = { anthropic: "mock", openai: "mock:alt", "x-ai": "mock:third" };

export function answerChat(body) {
  const stage = body.response_format?.json_schema?.name?.replace(/^council_/, "");
  const payload = JSON.parse(body.messages.find((m) => m.role === "user").content);
  const variant = VARIANT[body.model.split("/")[0]] || "mock";
  const glossary = payload.glossary ? parseGlossaryBlock(payload.glossary) : null;
  const items = payload.items.map((it) => {
    if (stage === "translate") return { key: it.key, translation: mockTranslateText(variant, it.source, payload.locale) };
    if (stage === "backtranslate") return { key: it.key, backtranslation: mockBacktranslateText(it.candidate, payload.locale) };
    if (stage === "judge") {
      const v = mockJudgeOne({ ...it, glossary });
      return { key: it.key, meaning: v.meaning, fluency: v.fluency, glossaryOk: v.glossaryOk, escalate: v.escalate, rationale: v.rationale };
    }
    const c = mockCompareOne(variant, it, payload.locale, glossary);
    return { key: it.key, pick: c.pick, rationale: c.rationale };
  });
  return {
    id: `gen-fake-${Date.now()}`,
    provider: "Fake",
    model: `${body.model}-20260901`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ items }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0005 },
  };
}

/**
 * @param {{ models?: string[], handler?: (req, body) => ({status, json, headers}|null) }} [opts]
 * @returns {Promise<{ url: string, requests: object[], close: () => Promise<void> }>}
 */
export async function startFakeOpenRouter(opts = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status, json, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(json));
      };
      if (req.method === "GET" && req.url.endsWith("/models")) {
        return send(200, { data: (opts.models || []).map((id) => ({ id })) });
      }
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ url: req.url, headers: req.headers, body });
      const custom = opts.handler?.(req, body, requests.length);
      if (custom) return send(custom.status, custom.json, custom.headers);
      if (!/^Bearer \S+/.test(req.headers.authorization || "")) return send(401, { error: { message: "No auth", code: 401 } });
      return send(200, answerChat(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}
