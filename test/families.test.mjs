import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { familyOf, diversityWarnings } from "../src/providers/families.mjs";
import { parseProviderSpec } from "../src/providers/resolve.mjs";

describe("familyOf", () => {
  it("maps CLIs, OpenRouter vendors, Jev, and mock", () => {
    assert.equal(familyOf("cli:claude"), "anthropic");
    assert.equal(familyOf("cli:grok"), "xai");
    assert.equal(familyOf("cli:codex"), "openai");
    assert.equal(familyOf("openrouter:anthropic/claude-opus-5.5"), "anthropic");
    assert.equal(familyOf("openrouter:x-ai/grok-4.7"), "xai");
    assert.equal(familyOf("openrouter:~openai/gpt-latest"), "openai");
    assert.equal(familyOf("openrouter:google/gemini-3-pro"), "google");
    assert.equal(familyOf("openrouter:somevendor/model"), "somevendor");
    assert.equal(familyOf("api:jev"), "typesafe");
    assert.equal(familyOf("mock:alt"), "mock");
  });

  it("treats a CLI and an OpenRouter model from the same vendor as one family", () => {
    const w = diversityWarnings({
      translate: "cli:claude",
      backtranslate: "openrouter:anthropic/claude-opus-5.5",
      judge: "cli:codex",
    });
    assert.deepEqual(w.map((x) => x.code), ["same_family_translate_backtranslate"]);
  });
});

describe("diversityWarnings", () => {
  it("shipped profiles are diverse", () => {
    for (const p of ["fleet", "openrouter", "mock"]) {
      assert.deepEqual(diversityWarnings(parseProviderSpec(p)), [], p);
    }
  });

  it("warns on every shared pair for a single-vendor run", () => {
    const w = diversityWarnings(parseProviderSpec("cli:claude"));
    assert.deepEqual(w.map((x) => x.code), [
      "same_family_translate_backtranslate",
      "same_family_judge_translate",
      "same_family_judge_backtranslate",
    ]);
    assert.match(w[0].message, /both anthropic/);
  });

  it("warns when the judge shares the translator's family", () => {
    const w = diversityWarnings({
      translate: "openrouter:openai/gpt-5.6-sol",
      backtranslate: "cli:grok",
      judge: "cli:codex",
    });
    assert.deepEqual(w.map((x) => x.code), ["same_family_judge_translate"]);
  });
});
