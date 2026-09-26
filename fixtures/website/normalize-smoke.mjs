#!/usr/bin/env node
/** Tiny fixture smoke for page-wrapper catalogs ({ page, locale, strings }). */
import { normalizeCatalog, computeMissingKeys } from "../../src/catalog.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const en = normalizeCatalog(JSON.parse(readFileSync(join(dir, "en.common.json"), "utf8")));
const de = normalizeCatalog(JSON.parse(readFileSync(join(dir, "de.common.json"), "utf8")));

if (Object.keys(en).length !== 3) throw new Error(`en expected 3, got ${Object.keys(en).length}`);
if (en["Skip to content"] !== "Skip to content") throw new Error("en id!==text");
if (de["Skip to content"] !== "Zum Inhalt springen") throw new Error("de map failed");
if ("page" in en || "locale" in en || "_comment" in en) throw new Error("metadata leaked");

const delta = computeMissingKeys(en, de);
if (delta.missing.length !== 1 || delta.missing[0].key !== "Pricing") {
  throw new Error(`expected Pricing missing, got ${JSON.stringify(delta.missing)}`);
}
console.log("ok: website wrapper normalize + delta");
