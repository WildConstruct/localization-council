import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  buildTidyQuestions,
  buildTidyState,
  mapTidyAnswers,
  buildTidyRow,
  tidyRowsToCsv,
  selectTidyKeys,
  loadBtMap,
  tidyMinConfidence,
  TIDY_CSV_HEADERS,
  TIDY_BT_MISSING,
  TIDY_WHY_BUCKETS,
} from "../src/tidy-audit.mjs";
import { runTidyAudit, parseKeysFile } from "../src/tidy.mjs";
import { JEV_DEFAULT_MODEL, JEV_CONFIDENCE_FLOOR } from "../src/providers/jev-openrouter.mjs";

describe("buildTidyQuestions", () => {
  it("batches reopen (noul), why_bucket (choice), priority (score)", () => {
    const q = buildTidyQuestions();
    assert.equal(q.reopen.type, "noul");
    assert.equal(q.why_bucket.type, "choice");
    assert.equal(q.priority.type, "score");
    for (const b of TIDY_WHY_BUCKETS) {
      assert.ok(q.why_bucket.criteria[b], `missing criteria ${b}`);
    }
  });

  it("can omit priority", () => {
    const q = buildTidyQuestions({ includePriority: false });
    assert.equal(q.priority, undefined);
  });
});

describe("buildTidyState", () => {
  it("uses lean judge state and BT placeholder when missing", () => {
    const state = buildTidyState({
      key: "ui.timeline.play",
      locale: "ja",
      en: "Play",
      candidate: "再生",
    });
    assert.equal(state.en, "Play");
    assert.equal(state.candidate, "再生");
    assert.equal(state.backtranslation, TIDY_BT_MISSING);
    assert.equal(state.locale, "ja");
    assert.equal(state.key, "ui.timeline.play");
  });
});

describe("mapTidyAnswers", () => {
  it("maps reopen noul + why_bucket + priority", () => {
    const d = mapTidyAnswers(
      {
        reopen: { noul: 0.8, confidence: 0.9 },
        why_bucket: { choice: "meaning", confidence: 0.85 },
        priority: { score: 1.5, confidence: 0.8 },
      },
      { key: "k1", model: "typesafe/jev-1.13", usage: { cost: 0.001 } },
    );
    assert.equal(d.reopen, true);
    assert.equal(d.why_bucket, "meaning");
    assert.equal(d.priority, 1.5);
    assert.equal(d.model, "typesafe/jev-1.13");
    assert.equal(d.cost, 0.001);
  });

  it("leaves closed when reopen low, why=fine, confidence ok", () => {
    const d = mapTidyAnswers({
      reopen: { noul: 0.1, confidence: 0.9 },
      why_bucket: { choice: "fine", confidence: 0.95 },
      priority: { score: 0.2, confidence: 0.9 },
    });
    assert.equal(d.reopen, false);
    assert.equal(d.why_bucket, "fine");
  });

  it("confidence < floor → reopen (noul 0.5 ≠ medium)", () => {
    assert.ok(JEV_CONFIDENCE_FLOOR === 0.5);
    const d = mapTidyAnswers({
      reopen: { noul: 0.2, confidence: 0.3 },
      why_bucket: { choice: "fine", confidence: 0.9 },
    });
    assert.equal(d.reopen, true);
    assert.equal(d.confidenceUnsure, true);
  });

  it("why_bucket ≠ fine forces reopen", () => {
    const d = mapTidyAnswers({
      reopen: { noul: 0.2, confidence: 0.9 },
      why_bucket: { choice: "glossary", confidence: 0.9 },
    });
    assert.equal(d.reopen, true);
    assert.equal(d.why_bucket, "glossary");
  });
});

describe("CSV row shape", () => {
  it("emits stable headers and escaped cells", () => {
    const row = buildTidyRow({
      key: "ui.a",
      locale: "ja",
      en: 'Say "hi"',
      candidate: "こんにちは",
      backtranslation: "Hello",
      decision: {
        reopen: true,
        why_bucket: "meaning",
        priority: 1,
        confidence_min: 0.7,
        model: JEV_DEFAULT_MODEL,
        cost: 0.002,
      },
    });
    for (const h of TIDY_CSV_HEADERS) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, h), h);
    }
    const csv = tidyRowsToCsv([row]);
    assert.match(csv, /^key,locale,en,/);
    assert.match(csv, /Say ""hi""/);
    assert.match(csv, /meaning/);
  });
});

describe("selectTidyKeys / loadBtMap", () => {
  it("intersects EN∩locale and respects limit", () => {
    const rows = selectTidyKeys(
      { a: "A", b: "B", c: "C" },
      { a: "あ", c: "う" },
      { limit: 1 },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, "a");
  });

  it("loads BT from array or map shapes", () => {
    assert.deepEqual(loadBtMap([{ key: "a", backtranslation: "X" }]), {
      a: "X",
    });
    assert.deepEqual(loadBtMap({ a: "Y", b: { backtranslation: "Z" } }), {
      a: "Y",
      b: "Z",
    });
  });
});

describe("runTidyAudit with mocked decide", () => {
  it("calls decide with questions and writes reopen from answers", async () => {
    const decideFn = mock.fn(async () => ({
      model: "typesafe/jev-1.13-test",
      usage: { cost: 0.0001 },
      answers: {
        reopen: { noul: 0.9, confidence: 0.8 },
        why_bucket: { choice: "ui_role", confidence: 0.8 },
        priority: { score: 2, confidence: 0.8 },
      },
    }));

    const result = await runTidyAudit({
      enMap: { "ui.timeline.play": "Play" },
      localeMap: { "ui.timeline.play": "再生" },
      locale: "ja",
      btMap: { "ui.timeline.play": "Playback" },
      decideFn,
      model: "typesafe/jev-1.13",
      apiKey: "test-key",
    });

    assert.equal(decideFn.mock.callCount(), 1);
    const [, questions] = decideFn.mock.calls[0].arguments;
    assert.equal(questions.reopen.type, "noul");
    assert.equal(result.reopenCount, 1);
    assert.equal(result.rows[0].why_bucket, "ui_role");
    assert.equal(result.modelId, "typesafe/jev-1.13-test");
  });

  it("skips Decisions when BT missing and marks reopen", async () => {
    const decideFn = mock.fn(async () => {
      throw new Error("should not be called");
    });
    const result = await runTidyAudit({
      enMap: { k: "Play" },
      localeMap: { k: "再生" },
      locale: "ja",
      btMap: {},
      decideFn,
    });
    assert.equal(decideFn.mock.callCount(), 0);
    assert.equal(result.skippedBt, 1);
    assert.equal(result.rows[0].reopen, true);
    assert.match(result.rows[0].note, /bt_missing/);
  });
});

describe("tidyMinConfidence", () => {
  it("returns min across present confidences", () => {
    assert.equal(
      tidyMinConfidence({
        reopen: { confidence: 0.9 },
        why_bucket: { confidence: 0.4 },
      }),
      0.4,
    );
  });
});

describe("parseKeysFile", () => {
  it("accepts JSON arrays, { keys }, objects, and line lists with comments", () => {
    assert.deepEqual(parseKeysFile('["a","b"]'), ["a", "b"]);
    assert.deepEqual(parseKeysFile('{"keys":["a"]}'), ["a"]);
    assert.deepEqual(parseKeysFile('{"a":1,"b":2}'), ["a", "b"]);
    assert.deepEqual(parseKeysFile("a\n# skip\n\nb\n"), ["a", "b"]);
  });
});
