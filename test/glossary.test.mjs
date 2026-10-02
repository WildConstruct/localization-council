import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateGlossary,
  glossaryPromptBlock,
  sourceHasTerm,
  sameTerm,
  glossarySlice,
  findRejectedTerms,
} from "../src/glossary.mjs";

const TOY_GLOSSARY = JSON.parse(readFileSync(new URL("../fixtures/toy/glossary.de.json", import.meta.url)));

function entry(over = {}) {
  return {
    source: "x",
    locale: "de",
    productMeaning: "m",
    relatedTerms: [],
    practitionerTerm: "p",
    approved: true,
    rejected: [],
    ...over,
  };
}

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

describe("term matching", () => {
  it("matches whole words, hyphen/space variants and English inflections", () => {
    const yes = [
      ["Onion skin", "onion skin"],
      ["Onion skinning", "onion skin"],
      ["Onion-skin overlay", "onion skin"],
      ["Precompose layers", "pre-compose"],
      ["Pre-composing…", "pre-compose"],
      ["New compositions", "composition"],
      ["Copies", "copy"],
      ["Rendering…", "render"],
      // Separators don't matter in either direction.
      ["Pre-compose layers", "precompose"],
      ["Onion skin", "onionskin"],
      ["E-mail address", "email"],
      ["Brushes", "brush"],
    ];
    const no = [
      ["Decomposition", "composition"],
      ["Player", "layer"],
      ["Renderer", "render"],
      ["Comp settings", "composition"],
      // Short words get few inflections: no "ad" in "Add", no "car" in "Card", no "IT" in "its".
      ["Add layer", "ad"],
      ["Used by", "US"],
      ["Uses", "US"],
      ["Save its state", "IT"],
      ["Game modes", "mod"],
      ["Bind", "bin"],
      ["Card details", "car"],
      ["Open Settings", "set"],
    ];
    for (const [text, term] of yes) assert.ok(sourceHasTerm(text, term), `${term} in ${text}`);
    for (const [text, term] of no) assert.ok(!sourceHasTerm(text, term), `${term} not in ${text}`);
  });

  it("compares terms with each other", () => {
    assert.ok(sameTerm("Layers", "layer"));
    assert.ok(sameTerm("precompose", "Pre-compose"));
    assert.ok(!sameTerm("render queue", "render"));
    assert.ok(!sameTerm("car", "card"));
    assert.ok(!sameTerm("set", "setting"));
    assert.ok(!sameTerm("ad", "add"));
  });

  it("the rejected-term check no longer fires inside a longer word", () => {
    const g = { locale: "de", entries: [entry({ source: "comp", rejected: [{ term: "Komp", why: "w" }] })] };
    assert.equal(findRejectedTerms("Compute", "Komp", g).length, 0);
    assert.equal(findRejectedTerms("New comp", "Neue Komp", g).length, 1);
    assert.equal(findRejectedTerms("Onion-skin overlay", "Zwiebelschale", TOY_GLOSSARY)[0].term, "Zwiebelschale");
  });
});

describe("glossarySlice", () => {
  it("keeps only the entries the sources use, and never declined terms", () => {
    const g = { ...TOY_GLOSSARY, version: "7", declined: [{ source: "play", why: "generic" }] };
    assert.equal(glossarySlice(g, ["Add layer"]), null);
    const s = glossarySlice(g, ["New composition", "Pre-compose"]);
    assert.deepEqual(s.entries.map((e) => e.source), ["composition", "pre-compose"]);
    assert.equal(s.locale, "de");
    assert.equal("declined" in s, false);
    assert.equal("version" in s, false);
    assert.equal(glossarySlice(null, ["x"]), null);
  });

  it("an entry also applies where one of its related terms appears", () => {
    assert.deepEqual(glossarySlice(TOY_GLOSSARY, ["Show ghost frames"]).entries.map((e) => e.source), ["onion skin"]);
    assert.deepEqual(glossarySlice(TOY_GLOSSARY, ["Pre-comp selected layers"]).entries.map((e) => e.source), ["composition", "pre-compose"]);
    // The deterministic rejected-term check stays on the entry's own term.
    assert.equal(findRejectedTerms("Show ghost frames", "Zwiebelschale zeigen", TOY_GLOSSARY).length, 0);
  });
});

describe("glossary growth fields", () => {
  it("accepts declined terms and entry origins, and rejects malformed ones", () => {
    const ok = validateGlossary({
      schemaVersion: "0",
      locale: "de",
      entries: [entry({ origin: { via: "harvest", keys: ["a", "b"] } })],
      declined: [{ source: "play", why: "Generic UI verb." }],
    });
    assert.equal(ok.declined.length, 1);
    assert.throws(
      () => validateGlossary({ schemaVersion: "0", locale: "de", entries: [], declined: [{ source: "x" }] }),
      /declined\[0\] must be/,
    );
    assert.throws(
      () => validateGlossary({ schemaVersion: "0", locale: "de", entries: [entry({ origin: { keys: [] } })] }),
      /origin must be/,
    );
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

describe("output placement", () => {
  it("warns when output would sit in this checkout outside scores/ and local/", async () => {
    const { councilCheckoutWarning } = await import("../src/config.mjs");
    const root = new URL("..", import.meta.url).pathname;
    assert.equal(councilCheckoutWarning(`${root}scores/de-glossary`, "--out"), null);
    assert.equal(councilCheckoutWarning(`${root}local/terms`, "--out"), null);
    assert.equal(councilCheckoutWarning("/somewhere/else", "--out"), null);
    assert.equal(councilCheckoutWarning(`${root}terminology`, "--out").code, "inside_council_checkout");
    assert.equal(councilCheckoutWarning(`${root}fixtures/toy/glossary.de.json`, "The glossary").code, "inside_council_checkout");
  });
});
