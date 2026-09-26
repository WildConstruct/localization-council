/**
 * Cached, batched execution of one provider stage.
 *
 * Every item is looked up in the result cache first (keyed on stage,
 * provider, model, prompt version, adapter settings and CLI version, locale,
 * glossary content hash, catalog key and the stage inputs). Only misses go to the adapter, in batches of
 * adapter.batchSize(stage); the cache is flushed after each batch so an
 * interrupted run resumes where it stopped.
 */

import { normalizeStageResults, chunk } from "../providers/contract.mjs";
import { ResultCache, glossaryHash } from "../run-context.mjs";

function inputsOf(stage, item) {
  if (stage === "translate") return { source: item.source };
  if (stage === "backtranslate") return { candidate: item.candidate };
  if (stage === "judge") return { source: item.source, candidate: item.candidate, backtranslation: item.backtranslation };
  return { source: item.source, options: item.options };
}

/**
 * @param {{ stage: string, adapter: object, locale: string, glossary?: object|null, items: object[], ctx: object }} opts
 * @returns {Promise<object[]>} normalized rows in input order
 */
export async function runStage({ stage, adapter, locale, glossary = null, items, ctx }) {
  const desc = adapter.describe(stage);
  const gv = glossaryHash(glossary);
  const results = new Array(items.length);
  const misses = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const hash = ResultCache.keyFor({
      stage,
      provider: desc.provider,
      model: desc.model,
      promptVersion: desc.promptVersion,
      salt: [desc.cacheSalt ?? null, ctx.providerSalt?.[desc.provider] ?? null],
      locale,
      glossary: stage === "backtranslate" ? null : gv,
      key: item.key,
      input: inputsOf(stage, item),
    });
    const hit = await ctx.cache.get(stage, hash);
    if (hit) results[i] = hit;
    else misses.push({ i, item, hash });
  }

  for (const group of chunk(misses, adapter.batchSize?.(stage) || 10)) {
    const batch = { locale, glossary: stage === "backtranslate" ? null : glossary, items: group.map((m) => m.item) };
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
