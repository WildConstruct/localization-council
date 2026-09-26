/**
 * The fixed batches every adapter runs in the contract test. The same
 * batches are sent live by `npm run smoke:openrouter -- --record` to refresh
 * test/fixtures/recorded/openrouter/.
 */
import { readFileSync } from "node:fs";

const glossary = JSON.parse(readFileSync(new URL("../../fixtures/toy/glossary.de.json", import.meta.url), "utf8"));

export const CONTRACT_BATCHES = {
  translate: {
    locale: "de",
    glossary,
    items: [
      { key: "ui.timeline.play", source: "Play" },
      { key: "ui.viewport.onion", source: "Onion skin" },
    ],
  },
  backtranslate: {
    locale: "de",
    glossary: null,
    items: [
      { key: "ui.timeline.play", candidate: "Abspielen" },
      { key: "ui.viewport.onion", candidate: "Onion Skin" },
    ],
  },
  judge: {
    locale: "de",
    glossary,
    items: [
      { key: "ui.timeline.play", source: "Play", candidate: "Abspielen", backtranslation: "Play" },
      { key: "ui.viewport.onion", source: "Onion skin", candidate: "Zwiebelschale", backtranslation: "Onion skin" },
    ],
  },
  compare: {
    locale: "de",
    glossary,
    items: [{ key: "ui.status.rendering", source: "Rendering…", options: { X: "Wird gerendert…", Y: "Rendern…" } }],
  },
};
