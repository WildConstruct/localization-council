import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateGlossary, glossaryPromptBlock } from "../src/glossary.mjs";

describe("validateGlossary", () => {
  it("accepts toy fixture", () => {
    const doc = JSON.parse(
      readFileSync(new URL("../fixtures/toy/glossary.de.json", import.meta.url)),
    );
    const v = validateGlossary(doc);
    assert.equal(v.locale, "de");
    assert.ok(v.entries.length >= 1);
  });

  it("rejects missing fields and bad rejected entries", () => {
    assert.throws(
      () => validateGlossary({ schemaVersion: "0", locale: "de" }),
      /entries/,
    );
    assert.throws(
      () =>
        validateGlossary({
          schemaVersion: "0",
          locale: "de",
          entries: [
            {
              source: "x",
              locale: "de",
              productMeaning: "m",
              relatedTerms: [],
              practitionerTerm: "p",
              approved: true,
              rejected: [{ term: "bad" }],
            },
          ],
        }),
      /rejected\[0\] must be/,
    );
    assert.throws(
      () =>
        validateGlossary({
          schemaVersion: "0",
          locale: "de",
          entries: [
            {
              source: "x",
              locale: "de",
              productMeaning: 1,
              relatedTerms: [],
              practitionerTerm: "p",
              approved: true,
              rejected: [],
            },
          ],
        }),
      /productMeaning must be a string/,
    );
  });

  it("builds prompt block", () => {
    const block = glossaryPromptBlock({
      locale: "de",
      entries: [
        {
          source: "composition",
          practitionerTerm: "Komposition",
          approved: true,
          productMeaning: "timeline container",
          rejected: [{ term: "Zusammensetzung", why: "chem" }],
        },
      ],
    });
    assert.match(block, /APPROVED/);
    assert.match(block, /reject "Zusammensetzung"/);
  });
});

describe("glossary locale vs run locale (S12)", () => {
  it("runCouncil rejects mismatched glossary locale unless override", async () => {
    const { runCouncil } = await import("../src/index.mjs");
    await assert.rejects(
      () =>
        runCouncil({
          catalog: new URL("../fixtures/toy/en.json", import.meta.url).pathname,
          locale: "fr",
          glossary: new URL("../fixtures/toy/glossary.de.json", import.meta.url).pathname,
          mock: true,
          out: "/tmp/lc-glossary-mismatch-test",
        }),
      /does not match run locale/,
    );
  });
});
