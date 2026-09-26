import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractIcuArgs,
  checkIcuStructure,
  ICU_PRESERVE_PROMPT,
} from "../src/icu.mjs";
import { buildEscalation } from "../src/pipeline/escalate.mjs";
import { translateStage } from "../src/pipeline/translate.mjs";
import { ResultCache } from "../src/run-context.mjs";

describe("extractIcuArgs", () => {
  it("extracts simple {var}", () => {
    const args = extractIcuArgs("Hello {name}");
    assert.equal(args.length, 1);
    assert.equal(args[0].name, "name");
    assert.equal(args[0].type, null);
  });

  it("extracts {var, number, …}", () => {
    const args = extractIcuArgs("Total {amount, number, ::currency/USD}");
    assert.equal(args.length, 1);
    assert.equal(args[0].name, "amount");
    assert.equal(args[0].type, "number");
  });

  it("extracts {var, date, …} and {var, time, …}", () => {
    const args = extractIcuArgs(
      "On {d, date, short} at {t, time, short}",
    );
    assert.deepEqual(
      args.map((a) => [a.name, a.type]),
      [
        ["d", "date"],
        ["t", "time"],
      ],
    );
  });

  it("extracts plural with one/other and #", () => {
    const src =
      "{count, plural, one {# item} other {# items}}";
    const args = extractIcuArgs(src);
    assert.equal(args.length, 1);
    assert.equal(args[0].name, "count");
    assert.equal(args[0].type, "plural");
    assert.deepEqual(args[0].branches, ["one", "other"]);
    assert.equal(args[0].hasHash, true);
  });

  it("extracts select branches", () => {
    const src =
      "{gender, select, male {He} female {She} other {They}} liked it";
    const args = extractIcuArgs(src);
    assert.equal(args[0].name, "gender");
    assert.equal(args[0].type, "select");
    assert.deepEqual(args[0].branches, ["female", "male", "other"]);
    assert.equal(args[0].hasHash, false);
  });

  it("extracts selectordinal", () => {
    const args = extractIcuArgs(
      "You came in {n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} place",
    );
    assert.equal(args[0].type, "selectordinal");
    assert.ok(args[0].branches.includes("other"));
    assert.equal(args[0].hasHash, true);
  });

  it("walks nested-ish plural with inner simple arg", () => {
    const src =
      "{count, plural, one {Hello {name}} other {{name} and # others}}";
    const args = extractIcuArgs(src);
    const names = args.map((a) => a.name);
    assert.ok(names.includes("count"));
    assert.ok(names.includes("name"));
    const plural = args.find((a) => a.name === "count");
    assert.equal(plural.hasHash, true);
  });

  it("skips mustache {{token}} (not ICU)", () => {
    const args = extractIcuArgs("Hi {{name}} and {count}");
    assert.deepEqual(
      args.map((a) => a.name),
      ["count"],
    );
  });

  it("handles =0 style plural keys", () => {
    const args = extractIcuArgs(
      "{n, plural, =0 {none} one {#} other {#}}",
    );
    assert.deepEqual(args[0].branches, ["=0", "one", "other"]);
  });
});

describe("checkIcuStructure", () => {
  it("ok for matching simple arg", () => {
    const r = checkIcuStructure("Hi {name}", "Hallo {name}");
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.extras, []);
  });

  it("ok for matching plural one/other with #", () => {
    const src = "{count, plural, one {# item} other {# items}}";
    const cand = "{count, plural, one {# Element} other {# Elemente}}";
    const r = checkIcuStructure(src, cand);
    assert.equal(r.ok, true);
  });

  it("allows Arabic target plural categories with a locale", () => {
    const src = "{count, plural, one {# layer} other {# layers}}";
    const cand = "{count, plural, zero {لا طبقات} one {طبقة} two {طبقتان} few {# طبقات} many {# طبقة} other {# طبقة}}";
    assert.equal(checkIcuStructure(src, cand, { locale: "ar" }).ok, true);
    assert.equal(checkIcuStructure(src, cand).ok, false);
  });

  it("allows Japanese to drop an unused one branch with a locale", () => {
    const src = "{count, plural, one {# layer} other {# layers}}";
    const cand = "{count, plural, other {#個のレイヤー}}";
    assert.equal(checkIcuStructure(src, cand, { locale: "ja" }).ok, true);
    assert.equal(checkIcuStructure(src, cand).ok, false);
  });

  it("rejects unknown target plural categories", () => {
    const src = "{count, plural, one {# layer} other {# layers}}";
    const cand = "{count, plural, one {طبقة} lots {# طبقات} other {# طبقة}}";
    const r = checkIcuStructure(src, cand, { locale: "ar" });
    assert.equal(r.ok, false);
    assert.ok(r.extras.includes("branch:count:lots"));
  });

  it("keeps select branch matching locale-independent", () => {
    const src = "{g, select, male {he} other {they}}";
    const cand = "{g, select, male {هو} few {هم} other {هم}}";
    assert.equal(checkIcuStructure(src, cand, { locale: "ar" }).ok, false);
  });

  it("still requires explicit numeric source branches", () => {
    const src = "{count, plural, =0 {none} one {# layer} other {# layers}}";
    const cand = "{count, plural, one {طبقة} other {# طبقة}}";
    const r = checkIcuStructure(src, cand, { locale: "ar" });
    assert.equal(r.ok, false);
    assert.ok(r.missing.includes("branch:count:=0"));
  });

  it("ok for matching select", () => {
    const src = "{g, select, male {he} female {she} other {they}}";
    const cand = "{g, select, male {er} female {sie} other {sie}}";
    assert.equal(checkIcuStructure(src, cand).ok, true);
  });

  it("fails when candidate missing other branch", () => {
    const src = "{count, plural, one {# item} other {# items}}";
    const cand = "{count, plural, one {# Element}}";
    const r = checkIcuStructure(src, cand);
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.includes("branch:count:other")));
  });

  it("fails when argument renamed", () => {
    const src = "Hello {name}";
    const cand = "Hallo {nombre}";
    const r = checkIcuStructure(src, cand);
    assert.equal(r.ok, false);
    assert.ok(r.missing.includes("arg:name"));
    assert.ok(r.extras.includes("arg:nombre"));
  });

  it("fails when # stripped from plural", () => {
    const src = "{count, plural, one {# item} other {# items}}";
    const cand = "{count, plural, one {item} other {items}}";
    const r = checkIcuStructure(src, cand);
    assert.equal(r.ok, false);
    assert.ok(r.missing.includes("hash:count"));
  });

  it("fails when type keyword dropped", () => {
    const src = "{n, number, percent}";
    const cand = "{n}";
    const r = checkIcuStructure(src, cand);
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.startsWith("type:n:number")));
  });

  it("ok for nested-ish when structure preserved", () => {
    const src =
      "{count, plural, one {Hi {name}} other {Hi {name} (#)}}";
    const cand =
      "{count, plural, one {Hallo {name}} other {Hallo {name} (#)}}";
    assert.equal(checkIcuStructure(src, cand).ok, true);
  });

  it("no ICU → ok", () => {
    assert.equal(checkIcuStructure("Hello", "Hallo").ok, true);
  });
});

describe("ICU_PRESERVE_PROMPT", () => {
  it("mentions MessageFormat keywords", () => {
    assert.match(ICU_PRESERVE_PROMPT, /MessageFormat/);
    assert.match(ICU_PRESERVE_PROMPT, /plural/);
    assert.match(ICU_PRESERVE_PROMPT, /#/);
  });
});

describe("pipeline ICU wiring", () => {
  it("translateStage applies target-locale plural categories", async () => {
    const adapter = {
      describe: () => ({ provider: "test", model: "test", family: "test", promptVersion: "t@1" }),
      batchSize: () => 10,
      translate: async (batch) => batch.items.map(({ key }) => ({
        key,
        candidate: "{count, plural, other {#個のレイヤー}}",
      })),
    };
    const candidates = await translateStage({
      sourceMap: { items: "{count, plural, one {# layer} other {# layers}}" },
      keys: ["items"],
      locale: "ja",
      glossary: null,
      adapter,
      ctx: { cache: new ResultCache(null, { enabled: false }) },
    });
    assert.equal(candidates[0].icuOk, true);
  });

  it("translateStage flags icuOk false on structure break", async () => {
    const adapter = {
      describe: () => ({ provider: "test", model: "test", family: "test", promptVersion: "t@1" }),
      batchSize: () => 10,
      // missing other + stripped #
      translate: async (batch) => batch.items.map(({ key }) => ({ key, candidate: "{count, plural, one {Element}}" })),
    };
    const candidates = await translateStage({
      sourceMap: {
        items: "{count, plural, one {# item} other {# items}}",
      },
      keys: ["items"],
      locale: "de",
      glossary: null,
      adapter,
      ctx: { cache: new ResultCache(null, { enabled: false }) },
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].icuOk, false);
    assert.ok(candidates[0].icuMissing.some((m) => m.includes("other") || m.includes("hash")));
  });

  it("buildEscalation adds icu_structure_break reason", () => {
    const escalation = buildEscalation({
      candidates: [
        {
          key: "items",
          source: "{count, plural, one {# item} other {# items}}",
          candidate: "{count, plural, one {Element}}",
          protectedTokensOk: true,
          icuOk: false,
          icuMissing: ["branch:count:other", "hash:count"],
          icuExtras: [],
          icuDetails: ["missing branch"],
        },
      ],
      scores: [
        {
          key: "items",
          meaning: 0.9,
          glossaryOk: true,
          escalate: false,
        },
      ],
    });
    assert.equal(escalation.count, 1);
    assert.ok(
      escalation.items[0].reasons.some((r) => r.startsWith("icu_structure_break:")),
    );
  });
});
