import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCandidateText,
  preGateDistinctCandidates,
  parseWinnerChoice,
  shouldAutoPickFaceoff,
  agreePriorByText,
  buildFaceoffQuestions,
  FACEOFF_CLEAR_MIN,
  FACEOFF_NEAR_MAX,
  FACEOFF_DIFF_MIN,
  FACEOFF_CONF_FLOOR,
} from "../src/providers/jev-faceoff.mjs";

describe("normalizeCandidateText", () => {
  it("trims and collapses whitespace / NBSP", () => {
    assert.equal(
      normalizeCandidateText("  foo\u00a0\u00a0bar  "),
      "foo bar",
    );
  });
});

describe("preGateDistinctCandidates", () => {
  it("marks A=B=C identical", () => {
    const pre = preGateDistinctCandidates({
      A: "Attractor X",
      B: "Attractor X",
      C: "Attractor X",
    });
    assert.equal(pre.status, "identical");
    assert.equal(pre.reason, "no_faceoff");
  });

  it("collapses NBSP / trailing WS to one distinct", () => {
    const pre = preGateDistinctCandidates({
      A: "hello",
      B: "hello ",
      C: "hello\u00a0",
    });
    assert.equal(pre.status, "identical");
  });

  it("keeps case / Turkish ı vs i distinct", () => {
    const pre = preGateDistinctCandidates({
      A: "Işık",
      B: "Isık",
    });
    assert.equal(pre.status, "distinct");
    assert.equal(pre.distinctIds.length, 2);
  });
});

describe("parseWinnerChoice", () => {
  const ids = ["X", "Y", "Z"];

  it("parses plain string", () => {
    assert.equal(parseWinnerChoice("Z", ids).pick, "Z");
  });

  it("parses {choice}", () => {
    assert.equal(parseWinnerChoice({ choice: "Y" }, ids).pick, "Y");
  });

  it("parses {selected}", () => {
    assert.equal(parseWinnerChoice({ selected: "X" }, ids).pick, "X");
  });

  it("parses probabilities distribution", () => {
    const r = parseWinnerChoice(
      { probabilities: { X: 0.2, Y: 0.1, Z: 0.7 } },
      ids,
    );
    assert.equal(r.pick, "Z");
    assert.equal(r.prob, 0.7);
    assert.ok(Math.abs(r.margin - 0.5) < 1e-9);
  });

  it("parses bare id→n map", () => {
    assert.equal(parseWinnerChoice({ X: 0.1, Y: 0.8, Z: 0.1 }, ids).pick, "Y");
  });

  it("parses array of {id,probability}", () => {
    assert.equal(
      parseWinnerChoice(
        [
          { id: "X", probability: 0.2 },
          { id: "Z", probability: 0.6 },
        ],
        ids,
      ).pick,
      "Z",
    );
  });

  it("strips Candidate prefix and uppercases", () => {
    assert.equal(parseWinnerChoice("Candidate z", ids).pick, "Z");
  });

  it("top-probability tie → pick null", () => {
    const r = parseWinnerChoice({ X: 0.5, Y: 0.5 }, ["X", "Y"]);
    assert.equal(r.pick, null);
    assert.equal(r.margin, 0);
  });

  it("unknown id → null", () => {
    assert.equal(parseWinnerChoice("Q", ids), null);
  });
});

describe("shouldAutoPickFaceoff", () => {
  const base = {
    preGate: { status: "distinct" },
    pick: "Z",
    clear: 0.8,
    near: 0.2,
    diff: 0.75,
    answers: {
      clear_winner: { noul: 0.8, confidence: 0.9 },
      near_tie: { noul: 0.2, confidence: 0.9 },
      winner: { choice: "Z", confidence: 0.9 },
      differentiation_enough: { noul: 0.75, confidence: 0.9 },
    },
    winnerProb: 0.7,
  };

  it("passes when all thresholds met", () => {
    const g = shouldAutoPickFaceoff(base);
    assert.equal(g.autoPick, true);
    assert.deepEqual(g.reasons, []);
  });

  it("blocks clear just below min", () => {
    const g = shouldAutoPickFaceoff({ ...base, clear: FACEOFF_CLEAR_MIN - 0.01 });
    assert.equal(g.autoPick, false);
    assert.ok(g.reasons.some((r) => r.startsWith("clear_below_")));
  });

  it("blocks near just above max", () => {
    const g = shouldAutoPickFaceoff({ ...base, near: FACEOFF_NEAR_MAX + 0.01 });
    assert.equal(g.autoPick, false);
    assert.ok(g.reasons.some((r) => r.startsWith("near_above_")));
  });

  it("blocks diff just below min", () => {
    const g = shouldAutoPickFaceoff({ ...base, diff: FACEOFF_DIFF_MIN - 0.01 });
    assert.equal(g.autoPick, false);
    assert.ok(g.reasons.some((r) => r.startsWith("diff_below_")));
  });

  it("blocks low confidence", () => {
    const g = shouldAutoPickFaceoff({
      ...base,
      answers: {
        ...base.answers,
        winner: { choice: "Z", confidence: FACEOFF_CONF_FLOOR - 0.01 },
      },
    });
    assert.equal(g.autoPick, false);
    assert.ok(g.reasons.some((r) => r.includes("confidence_winner")));
  });

  it("blocks missing noul", () => {
    const g = shouldAutoPickFaceoff({ ...base, clear: NaN });
    assert.equal(g.autoPick, false);
    assert.ok(g.reasons.includes("clear_missing"));
  });

  it("blocks identical pre-gate", () => {
    const g = shouldAutoPickFaceoff({
      ...base,
      preGate: { status: "identical" },
    });
    assert.equal(g.autoPick, false);
    assert.ok(g.reasons.includes("pre_gate_not_distinct"));
  });
});

describe("agreePriorByText", () => {
  it("counts agreement when pick text equals prior text (different ids)", () => {
    const row = {
      prior_pick: "Z",
      candidates: {
        X: "same text",
        Y: "other",
        Z: "same text",
      },
    };
    assert.equal(agreePriorByText(row, "X"), true);
    assert.equal(agreePriorByText(row, "Y"), false);
  });
});

describe("buildFaceoffQuestions", () => {
  it("embeds candidate text in winner criteria", () => {
    const q = buildFaceoffQuestions(
      {
        en: "Stagger",
        key: "params.force_map_stagger.label",
        locale: "tr",
        candidates: { X: "Kademelendir", Y: "Ardışık Kaydırma", Z: "Kademelendirme" },
      },
      ["X", "Y", "Z"],
    );
    assert.equal(q.winner.type, "choice");
    assert.match(q.winner.criteria.Z, /Kademelendirme/);
    assert.match(q.winner.instructions, /Stagger/);
    assert.match(q.clear_winner.instructions, /meaning/);
  });
});
