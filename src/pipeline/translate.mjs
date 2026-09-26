import { checkProtectedTokens } from "../catalog.mjs";
import { checkIcuStructure } from "../icu.mjs";
import { runStage } from "./stage.mjs";

/**
 * Deterministic structure checks on a candidate:
 * - protected tokens ({{…}}, printf, simple {name})
 * - ICU MessageFormat structure (typed args, plural/select branches, #)
 */
export function structureChecks(source, candidate, locale) {
  const tokenCheck = checkProtectedTokens(source, candidate);
  const icuCheck = checkIcuStructure(source, candidate, { locale });
  return {
    protectedTokensOk: tokenCheck.ok,
    protectedTokensMissing: tokenCheck.missing,
    icuOk: icuCheck.ok,
    icuMissing: icuCheck.missing,
    icuExtras: icuCheck.extras,
    icuDetails: icuCheck.details,
  };
}

/**
 * Translate source entries → candidates (with structure checks attached).
 * @param {{ sourceMap: Record<string,string>, keys: string[], locale: string, glossary?: object|null, adapter: object, ctx: object }} opts
 */
export async function translateStage({ sourceMap, keys, locale, glossary = null, adapter, ctx }) {
  const items = keys.filter((key) => sourceMap[key] != null).map((key) => ({ key, source: sourceMap[key] }));
  const rows = await runStage({ stage: "translate", adapter, locale, glossary, items, ctx });
  return rows.map((r) => ({ ...r, ...structureChecks(r.source, r.candidate, locale) }));
}
