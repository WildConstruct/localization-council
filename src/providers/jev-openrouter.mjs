/**
 * Optional TypeSafe Jev judge via the OpenRouter Decisions API.
 *
 * Judge / gate only — never translate or back-translate (those stages throw
 * UnsupportedStageError). Jev returns typed probabilities, so it fits
 * decision gates: accept vs escalate, and (for the blind audit) which of
 * several labeled candidates wins. See docs/jev-gates.md.
 *
 * Env:
 *   OPENROUTER_API_KEY  — required
 *   JEV_MODEL           — optional (default from config/models.json jev.defaultModel;
 *                         the resolved response.model is always recorded)
 *   JEV_DECISIONS_URL   — optional endpoint override
 */

import { glossaryPromptBlock } from "../glossary.mjs";
import { loadModelsConfig } from "../config.mjs";
import { resolveOpenRouterApiKey as envKey } from "./openrouter.mjs";
import { perItem, unsupported } from "./contract.mjs";
import {
  buildFaceoffQuestions,
  buildFaceoffState,
  parseWinnerChoice,
  shouldAutoPickFaceoff,
} from "./jev-faceoff.mjs";

const JEV_CFG = loadModelsConfig().jev;

export const JEV_DECISIONS_URL = JEV_CFG.decisionsUrl;
export const JEV_DEFAULT_MODEL = JEV_CFG.defaultModel;
export const JEV_PROVIDER_ID = "api:jev";

/** Meaning threshold aligned with other judges / pipeline. */
export const JEV_MEANING_THRESHOLD = 0.75;

/** Noul ≥ this counts as yes for escalate / glossaryOk / register / ui_role. */
export const JEV_NOUL_TRUE = 0.5;

/**
 * Confidence floor (separate from noul). When an answer reports `confidence`
 * and it is < this value, treat as unsure → escalate-to-human.
 * Noul 0.5 means P(yes)≈half, NOT "medium confidence".
 */
export const JEV_CONFIDENCE_FLOOR = 0.5;

/** Keys allowed in lean translator-judge state (plus product). */
export const JEV_LEAN_STATE_KEYS = Object.freeze([
  "product",
  "locale",
  "en",
  "candidate",
  "backtranslation",
  "key",
  "glossary_notes",
  "icuOk",
  "icuMissing",
  "icuExtras",
  "ui_role",
  "register",
]);

/**
 * Typed questions for translator-judge v1.
 * Core: escalate / meaning_ok / glossary_ok / quality.
 * Same-call add-ons: register_ok / ui_role_ok (cheap; soft-escalate when low).
 */
export function buildJevJudgeQuestions() {
  return {
    escalate: {
      type: "noul",
      instructions:
        "Should a human localization reviewer escalate this candidate before it ships?",
      criteria: {
        true: "Meaning drift, glossary violation, wrong UI role/POS, broken UI string, or insufficient confidence to auto-accept.",
        false: "Safe to accept under automated council rules; no human review needed.",
      },
    },
    meaning_ok: {
      type: "noul",
      instructions:
        "Does the candidate preserve the English source meaning for this product UI string? Weight the blind back-translation heavily: if the BT shows a different sense (e.g. Operation/Activation for Play, formula for composition, Processing for Rendering), meaning is not ok even if the candidate looks fluent.",
      criteria: {
        true: "Back-translation and candidate convey the same product intent as the source.",
        false: "Meaning drift, wrong sense, technical term loss, or BT that clearly mismatches the English source.",
      },
    },
    glossary_ok: {
      type: "noul",
      instructions:
        "Does the candidate respect approved glossary terms and avoid rejected terms when glossary notes are present? If glossary_notes are absent: still fail when the candidate is an obvious calque/literal of an established practitioner term that would confuse professional users; otherwise treat as ok.",
      criteria: {
        true: "Approved practitioner terms used correctly; no rejected terms. True if no glossary notes apply and no obvious practitioner-term calque.",
        false: "Approved term missing/altered, a rejected term appears, or an obvious food/chemical/literal calque of a known practitioner UI term.",
      },
    },
    quality: {
      type: "score",
      instructions:
        "Rate overall UI localization quality for a software product string.",
      criteria: [
        "Wrong or broken",
        "Usable but awkward",
        "Good UI localization",
      ],
    },
    register_ok: {
      type: "noul",
      instructions:
        "Does the candidate's register match typical software product UI voice for this key (neutral UI — not slang, game-like, or overly literary)?",
      criteria: {
        true: "Register fits product UI for this string type.",
        false: "Register is off (too casual, too formal, game-like, or literary).",
      },
    },
    ui_role_ok: {
      type: "noul",
      instructions:
        "Does morphosyntax / part-of-speech fit the UI role implied by the key and English source (e.g. timeline Play = command/imperative verb, not a noun label; status with ellipsis = progressive/status phrasing)?",
      criteria: {
        true: "POS and UI role match the control/label/status intent.",
        false: "Wrong POS or UI role (e.g. noun where an imperative is needed).",
      },
    },
  };
}

/** @deprecated use buildJevJudgeQuestions */
export const buildJevQuestions = buildJevJudgeQuestions;

/**
 * Lean state for Decisions API — only fields the translator-judge questions need.
 * Omits long Codex rationales and unused blobs. Allowed keys: JEV_LEAN_STATE_KEYS.
 */
export function buildJevJudgeState({
  source,
  candidate,
  backtranslation,
  locale,
  key,
  glossary,
  icuOk,
  icuMissing,
  icuExtras,
  ui_role,
  register,
} = {}) {
  const state = {
    product: "Software product UI localization",
    locale: locale ?? null,
    en: source ?? "",
    candidate: candidate ?? "",
    backtranslation: backtranslation ?? "",
  };
  if (key != null && key !== "") state.key = key;
  const notes = glossaryPromptBlock(glossary);
  if (notes) state.glossary_notes = notes;
  if (icuOk !== undefined && icuOk !== null) state.icuOk = Boolean(icuOk);
  if (Array.isArray(icuMissing) && icuMissing.length) {
    state.icuMissing = icuMissing;
  }
  if (Array.isArray(icuExtras) && icuExtras.length) {
    state.icuExtras = icuExtras;
  }
  if (ui_role) state.ui_role = ui_role;
  if (register) state.register = register;

  // Filter to lean keys only (drop accidental extras like rationale blobs).
  const lean = {};
  for (const k of JEV_LEAN_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(state, k)) lean[k] = state[k];
  }
  return lean;
}

/** @deprecated use buildJevJudgeState */
export const buildJevState = buildJevJudgeState;

/**
 * Resolve the OpenRouter API key from the environment. Never logged.
 * @param {{ env?: Record<string,string|undefined> }} [opts]
 */
export function resolveOpenRouterApiKey({ env = process.env } = {}) {
  return envKey(env);
}

function fmtNoul(n) {
  if (!Number.isFinite(n)) return "?";
  return n.toFixed(2);
}

/** A JSON number, or NaN (never coerce booleans / strings / arrays into scores). */
function num(v) {
  return typeof v === "number" ? v : NaN;
}

function readOptionalNoul(answers, id) {
  if (!answers || answers[id] == null) return null;
  const n = num(answers[id]?.noul);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/** Return confidence ∈ [0,1] when present; else null. */
function readOptionalConfidence(answers, id) {
  if (!answers || answers[id] == null) return null;
  const c = num(answers[id]?.confidence);
  if (!Number.isFinite(c) || c < 0 || c > 1) return null;
  return c;
}

/**
 * True when any watched answer reports confidence below the floor.
 * Watched: escalate, meaning_ok, ui_role_ok, register_ok, quality (overall).
 */
export function jevConfidenceUnsure(answers) {
  const ids = [
    "escalate",
    "meaning_ok",
    "ui_role_ok",
    "register_ok",
    "quality",
  ];
  for (const id of ids) {
    const c = readOptionalConfidence(answers, id);
    if (c != null && c < JEV_CONFIDENCE_FLOOR) return true;
  }
  return false;
}

/**
 * Low-level Decisions call. Reusable by future gate stages (routing, faceoff, register).
 * Does not map to judge shape — returns raw JSON `{ model, answers, usage, id, … }`.
 *
 * @param {string|object|array} state
 * @param {Record<string, object>} questions — noul | choice | score map
 * @param {{ fetchImpl?: typeof fetch, apiKey?: string|null, model?: string }} [opts]
 */
export async function jevDecide(state, questions, opts = {}) {
  if (!questions || typeof questions !== "object" || !Object.keys(questions).length) {
    throw new Error(`${JEV_PROVIDER_ID}: jevDecide requires a non-empty questions map`);
  }

  const apiKey =
    opts.apiKey !== undefined ? opts.apiKey : resolveOpenRouterApiKey();
  if (!apiKey) {
    throw new Error(
      `${JEV_PROVIDER_ID}: set OPENROUTER_API_KEY (OpenRouter Decisions API).`,
    );
  }

  const model = opts.model || process.env.JEV_MODEL || opts.models?.jev?.defaultModel || JEV_DEFAULT_MODEL;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(`${JEV_PROVIDER_ID}: fetch is not available`);
  }

  const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS) > 0 ? Number(process.env.OPENROUTER_TIMEOUT_MS) : 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetchImpl(process.env.JEV_DECISIONS_URL || opts.models?.jev?.decisionsUrl || JEV_DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, state, questions }),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    if (err?.name === "AbortError" || controller.signal.aborted) {
      throw new Error(`${JEV_PROVIDER_ID}: request timed out after ${timeoutMs}ms`);
    }
    throw new Error(`${JEV_PROVIDER_ID}: network error: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `${JEV_PROVIDER_ID} non-JSON HTTP ${res.status}: ${text.slice(0, 400)}`,
    );
  }

  if (!res.ok) {
    const msg =
      json?.error?.message ||
      json?.message ||
      JSON.stringify(json).slice(0, 400);
    throw new Error(`${JEV_PROVIDER_ID} HTTP ${res.status}: ${msg}`);
  }

  return json;
}

/**
 * Map Jev Decisions answers → council judge shape.
 * Prefer meaning = meaning_ok.noul; pipeline threshold decides pass/fail.
 * escalate true when Jev escalate noul ≥ 0.5 OR meaning < threshold OR !glossaryOk
 * OR (when present) ui_role_ok / register_ok noul < 0.5
 * OR confidence present and < JEV_CONFIDENCE_FLOOR on escalate / meaning_ok /
 *   ui_role_ok / register_ok / quality (overall uncertain).
 * Note: noul 0.5 ≠ "medium confidence" — noul is P(yes); confidence is certainty.
 */
export function mapJevAnswersToJudge(answers, { key, model, usage } = {}) {
  if (!answers || typeof answers !== "object") {
    throw new Error(`${JEV_PROVIDER_ID} judge missing answers object`);
  }

  const meaningOk = num(answers.meaning_ok?.noul);
  const escalateNoul = num(answers.escalate?.noul);
  const glossaryNoul = num(answers.glossary_ok?.noul);
  const qualityScore = num(answers.quality?.score);
  const registerOkNoul = readOptionalNoul(answers, "register_ok");
  const uiRoleOkNoul = readOptionalNoul(answers, "ui_role_ok");

  if (!Number.isFinite(meaningOk) || meaningOk < 0 || meaningOk > 1) {
    throw new Error(
      `${JEV_PROVIDER_ID} judge invalid meaning_ok.noul: ${JSON.stringify(answers.meaning_ok)}`,
    );
  }
  if (!Number.isFinite(escalateNoul) || escalateNoul < 0 || escalateNoul > 1) {
    throw new Error(
      `${JEV_PROVIDER_ID} judge invalid escalate.noul: ${JSON.stringify(answers.escalate)}`,
    );
  }
  if (!Number.isFinite(glossaryNoul) || glossaryNoul < 0 || glossaryNoul > 1) {
    throw new Error(
      `${JEV_PROVIDER_ID} judge invalid glossary_ok.noul: ${JSON.stringify(answers.glossary_ok)}`,
    );
  }

  const meaning = meaningOk;
  // quality is 0–2 weighted score → normalize to 0–1 fluency
  const fluency = Number.isFinite(qualityScore)
    ? Math.min(1, Math.max(0, qualityScore / 2))
    : meaning;
  const glossaryOk = glossaryNoul >= JEV_NOUL_TRUE;
  const roleFail =
    (uiRoleOkNoul != null && uiRoleOkNoul < JEV_NOUL_TRUE) ||
    (registerOkNoul != null && registerOkNoul < JEV_NOUL_TRUE);
  const confidenceUnsure = jevConfidenceUnsure(answers);
  const escalate =
    escalateNoul >= JEV_NOUL_TRUE ||
    meaning < JEV_MEANING_THRESHOLD ||
    glossaryOk === false ||
    roleFail ||
    confidenceUnsure;

  const qualityConf = readOptionalConfidence(answers, "quality");
  const rationaleParts = [
    `jev escalate=${fmtNoul(escalateNoul)}`,
    `meaning_ok=${fmtNoul(meaningOk)}`,
    `glossary_ok=${fmtNoul(glossaryNoul)}`,
    `quality=${fmtNoul(qualityScore)}`,
  ];
  if (registerOkNoul != null) {
    rationaleParts.push(`register_ok=${fmtNoul(registerOkNoul)}`);
  }
  if (uiRoleOkNoul != null) {
    rationaleParts.push(`ui_role_ok=${fmtNoul(uiRoleOkNoul)}`);
  }
  if (qualityConf != null) {
    rationaleParts.push(`quality_conf=${fmtNoul(qualityConf)}`);
  }
  if (confidenceUnsure) {
    rationaleParts.push("confidence_unsure=true");
  }

  const out = {
    provider: JEV_PROVIDER_ID,
    key,
    meaning,
    fluency,
    glossaryOk,
    glossaryNotes: [],
    escalate,
    rationale: rationaleParts.join(" "),
  };
  if (registerOkNoul != null) out.registerOk = registerOkNoul >= JEV_NOUL_TRUE;
  if (uiRoleOkNoul != null) out.uiRoleOk = uiRoleOkNoul >= JEV_NOUL_TRUE;
  if (confidenceUnsure) out.confidenceUnsure = true;
  // Always surface model (caller should pass response.model).
  out.model = model || process.env.JEV_MODEL || JEV_DEFAULT_MODEL;
  if (usage && typeof usage === "object") {
    out.usage = {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cost: usage.cost,
    };
  }
  return out;
}

/**
 * Council judge adapter: Decisions API → judge shape.
 * @param {object} input — same shape as other judges (+ optional icu / role hints)
 * @param {{ fetchImpl?: typeof fetch, apiKey?: string|null }} [opts]
 */
export async function jevOpenRouterJudge(input, opts = {}) {
  const {
    source,
    candidate,
    backtranslation,
    key,
    locale,
    glossary,
    icuOk,
    icuMissing,
    icuExtras,
    ui_role,
    register,
  } = input ?? {};

  const state = buildJevJudgeState({
    source,
    candidate,
    backtranslation,
    locale,
    key,
    glossary,
    icuOk,
    icuMissing,
    icuExtras,
    ui_role,
    register,
  });

  let json;
  try {
    json = await jevDecide(state, buildJevJudgeQuestions(), opts);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("set OPENROUTER_API_KEY")) {
      throw new Error(
        `${JEV_PROVIDER_ID}: set OPENROUTER_API_KEY (OpenRouter Decisions API). ` +
          `Jev is judge-only — use translate=cli:claude,backtranslate=cli:grok,judge=api:jev.`,
      );
    }
    throw err;
  }

  // Prefer live response.model (pin may resolve to dated build).
  const resolvedModel =
    json.model || process.env.JEV_MODEL || opts.models?.jev?.defaultModel || JEV_DEFAULT_MODEL;
  opts.ctx?.telemetry?.record({
    stage: "judge",
    provider: JEV_PROVIDER_ID,
    requestedModel: opts.model || process.env.JEV_MODEL || opts.models?.jev?.defaultModel || JEV_DEFAULT_MODEL,
    resolvedModel,
    costUsd: Number.isFinite(Number(json.usage?.cost)) ? Number(json.usage.cost) : null,
    ms: null,
  });
  return mapJevAnswersToJudge(json.answers, {
    key,
    model: resolvedModel,
    usage: json.usage,
  });
}

/**
 * Blind comparative pick via the faceoff v2 questions (clear_winner /
 * near_tie / winner / differentiation_enough). Jev only votes when the
 * auto-pick gate passes; otherwise it abstains (pick null) and says why.
 */
export async function jevCompare({ key, source, options, locale, glossary }, opts = {}) {
  const row = {
    key,
    en: source,
    locale,
    candidates: options,
    glossary_notes: glossaryPromptBlock(glossary) || undefined,
  };
  const ids = Object.keys(options);
  const json = await jevDecide(buildFaceoffState(row, ids), buildFaceoffQuestions(row, ids), opts);
  const answers = json.answers || {};
  const parsed = parseWinnerChoice(answers.winner, ids);
  const gate = shouldAutoPickFaceoff({
    preGate: { status: "distinct" },
    pick: parsed?.pick ?? null,
    clear: num(answers.clear_winner?.noul),
    near: num(answers.near_tie?.noul),
    diff: num(answers.differentiation_enough?.noul),
    answers,
    winnerProb: parsed?.prob ?? null,
  });
  const model = json.model || opts.model || process.env.JEV_MODEL || opts.models?.jev?.defaultModel || JEV_DEFAULT_MODEL;
  opts.ctx?.telemetry?.record({
    stage: "compare",
    provider: JEV_PROVIDER_ID,
    requestedModel: opts.model || process.env.JEV_MODEL || opts.models?.jev?.defaultModel || JEV_DEFAULT_MODEL,
    resolvedModel: model,
    costUsd: Number.isFinite(Number(json.usage?.cost)) ? Number(json.usage.cost) : null,
    ms: null,
  });
  const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "?");
  const rationale =
    `jev winner=${parsed?.pick ?? "?"} clear_winner=${fmt(answers.clear_winner?.noul)} ` +
    `near_tie=${fmt(answers.near_tie?.noul)} differentiation=${fmt(answers.differentiation_enough?.noul)}`;
  if (!gate.autoPick) {
    return { key, pick: "none", rationale, model, abstainReasons: gate.reasons };
  }
  return { key, pick: parsed.pick, rationale, model };
}

/**
 * Batch adapter. Jev is judge/compare-only.
 * @param {{ fetchImpl?: typeof fetch, apiKey?: string|null, model?: string }} [opts]
 */
export function createJevAdapter(opts = {}) {
  const hint = "Jev is a decision gate; use it for judge or blind-audit votes, e.g. translate=cli:claude,backtranslate=cli:grok,judge=api:jev";
  const model = () => opts.model || process.env.JEV_MODEL || opts.models?.jev?.defaultModel || JEV_DEFAULT_MODEL;
  return {
    id: JEV_PROVIDER_ID,
    family: "typesafe",
    describe(stage) {
      return { provider: JEV_PROVIDER_ID, model: model(), family: "typesafe", promptVersion: `jev/${stage}@2` };
    },
    batchSize() {
      return 1;
    },
    translate: unsupported(JEV_PROVIDER_ID, "translate", hint),
    backtranslate: unsupported(JEV_PROVIDER_ID, "backtranslate", hint),
    judge(batch, ctx) {
      return perItem(batch.items, (it) =>
        jevOpenRouterJudge({ ...it, locale: batch.locale, glossary: batch.glossary }, { ...opts, ctx }),
      );
    },
    compare(batch, ctx) {
      return perItem(batch.items, (it) =>
        jevCompare({ ...it, locale: batch.locale, glossary: batch.glossary }, { ...opts, ctx }),
      );
    },
  };
}
