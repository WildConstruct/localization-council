/**
 * Escalation and the human-readable report.
 *
 * The council never merges. A candidate either passes every check and is
 * accepted into output (accepted.json under --out), or it is escalated to a
 * human (escalate.json).
 */

import { findRejectedTerms } from "../glossary.mjs";

export const DEFAULT_MEANING_THRESHOLD = 0.75;

/**
 * Why a candidate cannot be accepted into output. Empty array = acceptable.
 * Shared by the core pipeline and every post-escalate stage, so nothing is
 * accepted on weaker terms than the core council applies.
 */
export function candidateReasons({ candidate, score, glossary = null, meaningThreshold = DEFAULT_MEANING_THRESHOLD }) {
  const reasons = [];
  if (!score) {
    reasons.push("missing_score");
  } else {
    if (score.meaning < meaningThreshold) reasons.push(`low_meaning:${score.meaning}`);
    if (score.glossaryOk === false) {
      reasons.push("glossary_violation");
      reasons.push(...(score.glossaryNotes ?? []));
    }
    if (score.escalate && score.meaning >= meaningThreshold && score.glossaryOk !== false) {
      reasons.push("judge_flagged");
    }
  }
  if (candidate.protectedTokensOk === false) {
    reasons.push(`protected_tokens_missing:${(candidate.protectedTokensMissing || []).join(",")}`);
  }
  if (candidate.icuOk === false) {
    const bits = [...(candidate.icuMissing || []), ...(candidate.icuExtras || [])];
    reasons.push(`icu_structure_break:${bits.length ? bits.join(",") : (candidate.icuDetails || []).join(";")}`);
  }
  if (score?.glossaryOk !== false) {
    for (const hit of findRejectedTerms(candidate.source, candidate.candidate, glossary)) {
      reasons.push(`glossary_rejected_term:${hit.term}`);
    }
  }
  return reasons;
}

/**
 * Split candidates into accepted and escalated.
 * @returns {{ threshold, count, items, accepted: object[] }}
 */
export function buildEscalation({ candidates, scores, glossary = null, meaningThreshold = DEFAULT_MEANING_THRESHOLD }) {
  const scoreByKey = new Map(scores.map((s) => [s.key, s]));
  const items = [];
  const accepted = [];
  for (const c of candidates) {
    const s = scoreByKey.get(c.key);
    const reasons = candidateReasons({ candidate: c, score: s, glossary, meaningThreshold });
    if (reasons.length) {
      items.push({
        key: c.key,
        source: c.source,
        candidate: c.candidate,
        backtranslation: null,
        meaning: s?.meaning ?? null,
        reasons,
        action: "human_review",
      });
    } else {
      accepted.push({ key: c.key, text: c.candidate, via: "council" });
    }
  }
  return { threshold: meaningThreshold, count: items.length, items, accepted };
}

function mdCell(s) {
  return String(s ?? "—")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

/**
 * Render report.md.
 */
export function renderReport({
  locale,
  profile,
  providers,
  candidates,
  scores,
  backtranslations = [],
  escalation,
  resolution = null,
  warnings = [],
  costUsd = null,
}) {
  const scoreByKey = new Map(scores.map((s) => [s.key, s]));
  const btByKey = new Map(backtranslations.map((b) => [b.key, b.backtranslation]));
  const lines = [
    `# Localization Council report: ${locale}`,
    "",
    `- Profile: \`${profile}\` (translate \`${providers.translate}\`, back-translate \`${providers.backtranslate}\`, judge \`${providers.judge}\`)`,
    `- Candidates: ${candidates.length}`,
    `- Accepted into output: ${escalation.acceptedCount ?? candidates.length - escalation.count}`,
    `- Escalated to a human: ${escalation.count}`,
    `- Meaning threshold: ${escalation.threshold}`,
  ];
  if (costUsd != null) lines.push(`- Provider cost (reported): $${costUsd}`);
  if (warnings.length) {
    lines.push("", "## Warnings", "");
    for (const w of warnings) lines.push(`- ${w.message}`);
  }

  lines.push("", "## Scores", "", "| Key | Meaning | Glossary | Judge flag |", "|-----|---------|----------|------------|");
  for (const c of candidates) {
    const s = scoreByKey.get(c.key);
    lines.push(
      `| \`${c.key}\` | ${s?.meaning ?? "—"} | ${s ? (s.glossaryOk ? "ok" : "FAIL") : "—"} | ${s?.escalate ? "yes" : "no"} |`,
    );
  }

  if (resolution) {
    lines.push("", "## Post-escalate resolution", "");
    lines.push(`- Escalated by the core council: ${resolution.initialEscalations}`);
    if (resolution.faceoff) lines.push(`- Faceoff auto-wins: ${resolution.faceoff.won} (near-ties: ${resolution.faceoff.nearTie})`);
    if (resolution.consensusCull) lines.push(`- Consensus cull accepted: ${resolution.consensusCull.accepted}`);
    if (resolution.blindAudit) {
      lines.push(
        `- Blind audit consensus: ${resolution.blindAudit.consensus} (unresolved: ${resolution.blindAudit.unresolved}; skipped with one distinct option: ${resolution.blindAudit.skipped ?? 0})`,
      );
    }
    if (resolution.resolved?.length) {
      lines.push("", "| Key | Accepted text | Via |", "|-----|---------------|-----|");
      for (const r of resolution.resolved) lines.push(`| \`${r.key}\` | ${mdCell(r.text)} | ${r.via} |`);
    }
  }

  lines.push("", "## Escalations", "");
  if (!escalation.items.length) {
    lines.push("_None. Spot-check accepted strings before you merge them._");
  } else {
    lines.push("| Key | Source | Candidate | Back-translation | Meaning | Reasons |", "|-----|--------|-----------|------------------|---------|---------|");
    for (const e of escalation.items) {
      lines.push(
        `| \`${e.key}\` | ${mdCell(e.source)} | ${mdCell(e.candidate)} | ${mdCell(e.backtranslation ?? btByKey.get(e.key))} | ${e.meaning ?? "—"} | ${mdCell(e.reasons.join("; "))} |`,
      );
    }
  }
  lines.push(
    "",
    "---",
    "_Generated by localization-council. The council accepts into output under --out; a person merges._",
    "",
  );
  return lines.join("\n");
}
