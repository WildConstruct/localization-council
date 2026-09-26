/**
 * Jev faceoff gate (v2): clear_winner / near_tie / winner /
 * differentiation_enough, with auto-pick floors.
 *
 * Used by the api:jev adapter's compare() (blind-audit vote). Jev votes only
 * when every floor passes; otherwise it abstains and the reasons are
 * recorded. Thresholds below are the v2 defaults from the Turkish faceoff
 * bakeoff; see docs/jev-gates.md.
 */

import { normalizeCandidateText } from "./contract.mjs";

export { normalizeCandidateText };

/** clear_winner.noul must be ≥ this to auto-pick. */
export const FACEOFF_CLEAR_MIN = 0.75;
/** near_tie.noul must be ≤ this to auto-pick. */
export const FACEOFF_NEAR_MAX = 0.3;
/** differentiation_enough.noul must be ≥ this to auto-pick. */
export const FACEOFF_DIFF_MIN = 0.7;
/** Per-answer confidence floor for auto-pick (stricter than JEV_CONFIDENCE_FLOOR). */
export const FACEOFF_CONF_FLOOR = 0.65;
/** When a winner distribution is present, top mass must be ≥ this. */
export const FACEOFF_WINNER_MIN_PROB = 0.6;
/** Do not trust Jev as the sole auto-picker until agreement with human picks is ≥ this %… */
export const FACEOFF_AGREE_MIN_PCT = 90;
/** …measured on at least this many labeled rows with distinct candidates. */
export const FACEOFF_AGREE_MIN_N = 20;

/**
 * Pre-gate: collapse identical (normalized) candidates.
 * @returns {{ status: "identical"|"distinct", distinctIds: string[], textByNorm: Map<string,string[]>, reason?: string }}
 */
export function preGateDistinctCandidates(candidates) {
  const ids = Object.keys(candidates || {});
  /** @type {Map<string, string[]>} */
  const textByNorm = new Map();
  for (const id of ids) {
    const norm = normalizeCandidateText(candidates[id]);
    if (!textByNorm.has(norm)) textByNorm.set(norm, []);
    textByNorm.get(norm).push(id);
  }
  const distinctNorms = [...textByNorm.keys()];
  if (distinctNorms.length <= 1) {
    return {
      status: "identical",
      distinctIds: ids.slice(0, 1),
      textByNorm,
      reason: "no_faceoff",
    };
  }
  // Prefer first id per distinct text (stable order of Object.keys)
  const distinctIds = distinctNorms.map((n) => textByNorm.get(n)[0]);
  return { status: "distinct", distinctIds, textByNorm };
}

function inferUiRole(key) {
  if (!key || typeof key !== "string") return "UI string";
  const k = key.toLowerCase();
  if (k.endsWith(".tooltip") || k.includes(".tooltip")) return "tooltip";
  if (k.endsWith(".hint") || k.includes(".hint")) return "hint";
  if (k.endsWith(".label") || k.includes(".label")) return "label";
  if (k.includes("button") || k.includes(".action")) return "command";
  return "UI string";
}

function glossaryHint(row) {
  const notes = row?.glossary_notes || row?.glossaryHint;
  if (!notes) return "";
  if (typeof notes === "string" && notes.trim()) return ` (glossary: ${notes.trim()})`;
  if (Array.isArray(notes) && notes.length) {
    return ` (glossary: ${notes.map((n) => (typeof n === "string" ? n : JSON.stringify(n))).join("; ")})`;
  }
  return "";
}

/**
 * Build faceoff questions. Pass full row so winner criteria include candidate text.
 * @param {object} row - { en, locale?, key?, candidates, glossary_notes? }
 * @param {string[]} [candidateIds] - subset of ids to ask about (distinct texts)
 */
export function buildFaceoffQuestions(row, candidateIds) {
  const candidates = row.candidates || {};
  const ids = candidateIds || Object.keys(candidates);
  const idList = ids.join("/");
  const en = row.en ?? "";
  const locale = row.locale || "the target locale";
  const uiRole = inferUiRole(row.key);
  const gHint = glossaryHint(row);

  return {
    clear_winner: {
      type: "noul",
      instructions: `Compare candidates ${idList} for EN "${en}" (${uiRole}, software product, locale ${locale}). Is exactly one candidate strictly better than all others on EN meaning, glossary terms, and UI register?`,
      criteria: {
        true: "One candidate is correct on meaning, glossary, and register, and every other candidate has at least one concrete defect it avoids.",
        false:
          "Two or more candidates are equally correct, or all share the same defect, or differences are only stylistic.",
      },
    },
    near_tie: {
      type: "noul",
      instructions: `Would a professional ${locale} UI reviewer accept the top two candidates equally for shipping?`,
      criteria: {
        true: "Top two are both shippable; differences are word order, synonyms, or punctuation with no meaning, glossary, or register error.",
        false:
          "At least one of the top two has a meaning, glossary, or register error the other avoids.",
      },
    },
    winner: {
      type: "choice",
      instructions: `Pick the candidate that best preserves the meaning of EN "${en}", uses the required glossary terms${gHint}, and matches the UI register for a ${uiRole}. Judge correctness first, style last. Candidates: ${idList}.`,
      criteria: Object.fromEntries(
        ids.map((id) => [
          id,
          `${id} = "${normalizeCandidateText(candidates[id])}": faithful to the EN meaning, uses glossary terms correctly, matches UI register for a ${uiRole}, and has no error that another candidate avoids.`,
        ]),
      ),
    },
    differentiation_enough: {
      type: "noul",
      instructions:
        "Is the gap between the best candidate and the rest a correctness gap (meaning, glossary, register) rather than a stylistic preference?",
      criteria: {
        true: "The non-winning candidates contain an error a reviewer would flag; picking the winner fixes it.",
        false:
          "The gap is stylistic or preference-only; a wrong auto-pick would be arguable.",
      },
    },
  };
}

export function buildFaceoffState(row, candidateIds) {
  const ids = candidateIds || Object.keys(row.candidates || {});
  const candidates = {};
  for (const id of ids) {
    candidates[id] = row.candidates[id];
  }
  return {
    product: "Software product UI localization",
    locale: row.locale ?? null,
    en: row.en,
    key: row.key,
    candidates,
  };
}

/**
 * Parse Jev choice answer into { pick, prob, margin } | null.
 * Accepts string, {choice|selected|answer|value}, distributions, bare maps, arrays.
 */
export function parseWinnerChoice(answer, ids) {
  if (answer == null) return null;
  const idSet = new Set(ids);
  const canon = (raw) => {
    if (raw == null) return null;
    let s = String(raw).trim();
    s = s.replace(/^Candidate\s+/i, "").trim();
    // Prefer exact match, then case-insensitive
    if (idSet.has(s)) return s;
    const upper = s.toUpperCase();
    for (const id of ids) {
      if (id.toUpperCase() === upper) return id;
    }
    return null;
  };

  if (typeof answer === "string") {
    const pick = canon(answer);
    return pick ? { pick, prob: null, margin: null } : null;
  }

  if (typeof answer !== "object") return null;

  for (const key of ["choice", "selected", "answer", "value"]) {
    if (answer[key] != null && typeof answer[key] !== "object") {
      const pick = canon(answer[key]);
      if (pick) return { pick, prob: null, margin: null };
    }
  }

  let dist = null;
  if (answer.probabilities && typeof answer.probabilities === "object") {
    dist = answer.probabilities;
  } else if (answer.distribution && typeof answer.distribution === "object") {
    dist = answer.distribution;
  } else if (answer.scores && typeof answer.scores === "object") {
    dist = answer.scores;
  } else if (Array.isArray(answer)) {
    dist = {};
    for (const item of answer) {
      if (!item || typeof item !== "object") continue;
      const id = canon(item.id ?? item.choice ?? item.label);
      const p = Number(item.probability ?? item.p ?? item.score ?? item.mass);
      if (id && Number.isFinite(p)) dist[id] = p;
    }
  } else {
    // Bare { id: n } or { id: { probability } }
    const entries = Object.entries(answer).filter(([k]) => {
      if (["type", "confidence", "choice", "selected", "answer", "value", "probabilities", "distribution", "scores", "noul", "score"].includes(k)) {
        return false;
      }
      return true;
    });
    if (entries.length) {
      dist = {};
      for (const [k, v] of entries) {
        const id = canon(k);
        if (!id) continue;
        const p =
          typeof v === "number"
            ? v
            : Number(v?.probability ?? v?.p ?? v?.score ?? v?.mass);
        if (Number.isFinite(p)) dist[id] = p;
      }
    }
  }

  if (!dist || !Object.keys(dist).length) return null;

  const ranked = Object.entries(dist)
    .map(([k, v]) => [canon(k), Number(v)])
    .filter(([id, p]) => id && Number.isFinite(p))
    .sort((a, b) => b[1] - a[1]);

  if (!ranked.length) return null;
  const [topId, topP] = ranked[0];
  const secondP = ranked.length > 1 ? ranked[1][1] : null;
  if (secondP != null && topP === secondP) {
    return { pick: null, prob: topP, margin: 0 };
  }
  return {
    pick: topId,
    prob: topP,
    margin: secondP != null ? topP - secondP : null,
  };
}

function answerConfidence(answer) {
  if (!answer || typeof answer !== "object") return null;
  const c = Number(answer.confidence);
  return Number.isFinite(c) ? c : null;
}

/**
 * Auto-pick gate: high clear, low near, high diff, confidence floors, valid pick.
 * @returns {{ autoPick: boolean, reasons: string[] }}
 */
export function shouldAutoPickFaceoff({
  preGate,
  pick,
  clear,
  near,
  diff,
  answers,
  winnerProb,
  thresholds = {},
} = {}) {
  const clearMin = thresholds.clearMin ?? FACEOFF_CLEAR_MIN;
  const nearMax = thresholds.nearMax ?? FACEOFF_NEAR_MAX;
  const diffMin = thresholds.diffMin ?? FACEOFF_DIFF_MIN;
  const confFloor = thresholds.confFloor ?? FACEOFF_CONF_FLOOR;
  const winnerMinProb = thresholds.winnerMinProb ?? FACEOFF_WINNER_MIN_PROB;

  const reasons = [];

  if (!preGate || preGate.status !== "distinct") {
    reasons.push("pre_gate_not_distinct");
  }
  if (pick == null || pick === "") {
    reasons.push("no_valid_pick");
  }
  if (!Number.isFinite(clear)) reasons.push("clear_missing");
  else if (clear < clearMin) reasons.push(`clear_below_${clearMin}`);

  if (!Number.isFinite(near)) reasons.push("near_missing");
  else if (near > nearMax) reasons.push(`near_above_${nearMax}`);

  if (!Number.isFinite(diff)) reasons.push("diff_missing");
  else if (diff < diffMin) reasons.push(`diff_below_${diffMin}`);

  const watched = ["clear_winner", "near_tie", "winner", "differentiation_enough"];
  for (const id of watched) {
    const c = answerConfidence(answers?.[id]);
    if (c != null && c < confFloor) {
      reasons.push(`confidence_${id}_below_${confFloor}`);
    }
  }

  if (winnerProb != null && Number.isFinite(winnerProb) && winnerProb < winnerMinProb) {
    reasons.push(`winner_prob_below_${winnerMinProb}`);
  }

  return { autoPick: reasons.length === 0, reasons };
}

/**
 * Agreement by normalized text (not id), for labeled rows with prior + distinct texts.
 */
export function agreePriorByText(row, pick) {
  if (row.prior_pick == null || pick == null) return null;
  const priorText = normalizeCandidateText(row.candidates?.[row.prior_pick]);
  const pickText = normalizeCandidateText(row.candidates?.[pick]);
  if (!priorText || !pickText) return null;
  return priorText === pickText;
}
