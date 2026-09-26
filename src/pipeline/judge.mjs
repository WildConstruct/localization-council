import { runStage } from "./stage.mjs";

/**
 * Judge meaning fidelity (source vs blind back-translation), fluency, and
 * glossary compliance.
 */
export async function judgeStage({ sourceMap, candidates, backtranslations, locale, glossary = null, adapter, ctx }) {
  const btByKey = new Map(backtranslations.map((b) => [b.key, b]));
  const items = candidates.map((c) => ({
    key: c.key,
    source: c.source ?? sourceMap[c.key],
    candidate: c.candidate,
    backtranslation: btByKey.get(c.key)?.backtranslation ?? "",
  }));
  return runStage({ stage: "judge", adapter, locale, glossary, items, ctx });
}
