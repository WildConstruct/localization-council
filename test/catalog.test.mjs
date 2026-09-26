import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCatalog,
  computeMissingKeys,
  extractProtectedTokens,
  checkProtectedTokens,
} from "../src/catalog.mjs";

describe("normalizeCatalog", () => {
  it("accepts flat string maps", () => {
    assert.deepEqual(normalizeCatalog({ a: "A", b: "B" }), { a: "A", b: "B" });
  });

  it("accepts { text } nested values", () => {
    assert.deepEqual(normalizeCatalog({ a: { text: "A" } }), { a: "A" });
  });

  it("accepts list of {id,text}", () => {
    assert.deepEqual(
      normalizeCatalog([{ id: "k", text: "v" }, { key: "k2", value: "v2" }]),
      { k: "v", k2: "v2" },
    );
  });

  it("unwraps page-wrapper strings[] (id === text)", () => {
    const map = normalizeCatalog({
      page: "common",
      locale: "en",
      _comment: ["x"],
      strings: ["Skip to content", "Pricing"],
    });
    assert.deepEqual(map, {
      "Skip to content": "Skip to content",
      Pricing: "Pricing",
    });
    assert.equal("page" in map, false);
  });

  it("unwraps page-wrapper strings{} map", () => {
    const map = normalizeCatalog({
      page: "common",
      locale: "de",
      strings: { "Skip to content": "Zum Inhalt" },
    });
    assert.deepEqual(map, { "Skip to content": "Zum Inhalt" });
  });

  it("rejects bad strings types", () => {
    assert.throws(() => normalizeCatalog({ strings: 1 }), /strings must be/);
    assert.throws(
      () => normalizeCatalog({ strings: [1] }),
      /strings\[\] entry must be a string/,
    );
  });

  it("rejects non-string catalog entries", () => {
    assert.throws(() => normalizeCatalog({ a: 1 }), /not a string/);
  });

  it("rejects duplicate list ids (S9)", () => {
    assert.throws(
      () =>
        normalizeCatalog([
          { id: "a", text: "A" },
          { id: "a", text: "A2" },
        ]),
      /Duplicate catalog id/,
    );
    assert.throws(
      () => normalizeCatalog({ strings: ["X", "X"] }),
      /Duplicate catalog id/,
    );
  });
});

describe("computeMissingKeys", () => {
  it("detects missing and identical_to_source", () => {
    const src = { a: "A", b: "B", c: "C" };
    const tgt = { a: "Ä", b: "B", c: "" };
    const d = computeMissingKeys(src, tgt);
    assert.deepEqual(
      d.missing.map((m) => m.key).sort(),
      ["c"],
    );
    assert.deepEqual(
      d.untranslated.map((u) => u.key),
      ["b"],
    );
  });

  it("website fixture delta: Pricing missing", () => {
    const en = normalizeCatalog({
      strings: ["Skip to content", "Products", "Pricing"],
    });
    const de = normalizeCatalog({
      strings: {
        "Skip to content": "Zum Inhalt springen",
        Products: "Produkte",
      },
    });
    const d = computeMissingKeys(en, de);
    assert.equal(d.missing.length, 1);
    assert.equal(d.missing[0].key, "Pricing");
  });
});

describe("protected tokens", () => {
  it("extracts {{}} and {icu}", () => {
    const toks = extractProtectedTokens("Hello {{name}} and {count}");
    assert.ok(toks.includes("{{name}}"));
    assert.ok(toks.includes("{count}"));
  });

  it("checkProtectedTokens reports missing", () => {
    const r = checkProtectedTokens("Hi {{name}}", "Hallo");
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ["{{name}}"]);
  });
});
