import { runStage } from "./stage.mjs";

/**
 * Blind back-translation: candidate → English. The source is never sent.
 */
export async function backtranslateStage({ candidates, locale, adapter, ctx }) {
  const items = candidates.map((c) => ({ key: c.key, candidate: c.candidate }));
  return runStage({ stage: "backtranslate", adapter, locale, glossary: null, items, ctx });
}
