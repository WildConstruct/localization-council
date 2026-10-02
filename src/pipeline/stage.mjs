/**
 * Cached, batched execution of one provider stage.
 *
 * Every item is looked up in the result cache first (keyed on stage,
 * provider, model, prompt version, adapter settings and CLI version, locale,
 * the glossary entries the item's source uses, catalog key and the stage
 * inputs). Only misses go to the adapter, in batches of adapter.batchSize(stage);
 * the cache is flushed after each batch so an interrupted run resumes where it
 * stopped.
 *
 * Providers see only the glossary entries a batch's sources use
 * (glossarySlice), so a growing glossary keeps prompts small and an added
 * entry re-runs only the strings that contain its term.
 */

import { normalizeStageResults, chunk } from "../providers/contract.mjs";
import { ResultCache, glossaryHash } from "../run-context.mjs";
import { glossarySlice } from "../glossary.mjs";

/** Stages whose provider sees no glossary (blind back-translation, term extraction). */
const NO_GLOSSARY = new Set(["backtranslate", "terms"]);

/** The glossary entries any of the given item slices use, in glossary order; null when none. */
function unionSlice(glossary, slices) {
  const used = new Set(slices.flatMap((s) => s?.entries ?? []));
  if (!used.size) return null;
  return { schemaVersion: glossary.schemaVersion, locale: glossary.locale, entries: glossary.entries.filter((e) => used.has(e)) };
}

function inputsOf(stage, item) {
  if (stage === "translate") return { source: item.source };
  if (stage === "backtranslate") return { candidate: item.candidate };
  if (stage === "judge") return { source: item.source, candidate: item.candidate, backtranslation: item.backtranslation };
  if (stage === "terms") return { source: item.source, candidate: item.candidate };
  return { source: item.source, options: item.options };
}

/**
 * @param {{ stage: string, adapter: object, locale: string, glossary?: object|null, items: object[], ctx: object }} opts
 * @returns {Promise<object[]>} normalized rows in input order
 */
export async function runStage({ stage, adapter, locale, glossary = null, items, ctx }) {
  const desc = adapter.describe(stage);
  const useGlossary = glossary && !NO_GLOSSARY.has(stage);
  const results = new Array(items.length);
  const misses = [];

  // Each item's glossary slice, computed once: it keys the cache and builds the batch's glossary.
  const slices = items.map((item) => (useGlossary ? glossarySlice(glossary, [item.source]) : null));

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const hash = ResultCache.keyFor({
      stage,
      provider: desc.provider,
      model: desc.model,
      promptVersion: desc.promptVersion,
      salt: [desc.cacheSalt ?? null, ctx.providerSalt?.[desc.provider] ?? null],
      locale,
      // No entry applies → the same key as a run without a glossary.
      glossary: slices[i] ? glossaryHash(slices[i]) : null,
      key: item.key,
      input: inputsOf(stage, item),
    });
    const hit = await ctx.cache.get(stage, hash);
    if (hit) results[i] = hit;
    else misses.push({ i, item, hash });
  }

  for (const group of chunk(misses, adapter.batchSize?.(stage) || 10)) {
    const batch = { locale, glossary: useGlossary ? unionSlice(glossary, group.map((m) => slices[m.i])) : null, items: group.map((m) => m.item) };
    ctx.log?.(`[${desc.provider}] ${stage} ×${group.length}`);
    const raw = await adapter[stage](batch, ctx);
    const rows = normalizeStageResults(stage, batch, raw, desc);
    for (let j = 0; j < group.length; j++) {
      results[group[j].i] = rows[j];
      await ctx.cache.set(stage, group[j].hash, rows[j]);
    }
    await ctx.cache.flush();
  }
  return results;
}
