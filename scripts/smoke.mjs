#!/usr/bin/env node
/**
 * Optional live smoke tests. Never part of CI.
 *
 *   npm run smoke:openrouter            # needs OPENROUTER_API_KEY
 *   npm run smoke:fleet                 # needs claude, grok and codex CLIs, logged in
 *   npm run smoke:openrouter -- --record  # also refresh test/fixtures/recorded/openrouter/
 *
 * Skips (exit 0) with a one-line reason when the profile is not runnable on
 * this machine. Otherwise runs the toy German catalog with every
 * post-escalate stage, plus the tr / ar / he RTL smoke catalog, and checks
 * that every summary and manifest matches its schema. Exit 1 on any failure.
 * Escalations are expected (exit 10 from a run is not a smoke failure).
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCouncil } from "../src/index.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { validate, validateDef } from "../src/json-schema.mjs";
import { loadModelsConfig } from "../src/config.mjs";
import { createOpenRouterAdapter } from "../src/providers/openrouter.mjs";
import { Telemetry } from "../src/run-context.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv[2];
const record = process.argv.includes("--record");

if (!["openrouter", "fleet"].includes(profile)) {
  console.error("usage: node scripts/smoke.mjs <openrouter|fleet> [--record]");
  process.exit(2);
}

const doctor = await runDoctor({ profile });
if (!doctor.profiles[profile].runnable) {
  console.log(`smoke:${profile}: skip (missing ${doctor.profiles[profile].missing.join(", ")})`);
  process.exit(0);
}

const out = join(ROOT, "scores", `smoke-${profile}`);
const runs = [
  { locale: "de", catalog: "fixtures/toy/en.json", glossary: "fixtures/toy/glossary.de.json", post: true },
  { locale: "tr", catalog: "fixtures/rtl-smoke/en.json", glossary: "fixtures/rtl-smoke/glossary.tr.json" },
  { locale: "ar", catalog: "fixtures/rtl-smoke/en.json" },
  { locale: "he", catalog: "fixtures/rtl-smoke/en.json" },
];

let failed = false;
const rows = [];
for (const r of runs) {
  const dir = join(out, r.locale);
  try {
    const s = await runCouncil({
      catalog: join(ROOT, r.catalog),
      glossary: r.glossary ? join(ROOT, r.glossary) : undefined,
      locale: r.locale,
      profile,
      out: dir,
      faceoff: r.post,
      consensusCull: r.post,
      blindAudit: r.post,
    });
    const problems = [
      ...validate(s, "summary.v1.json").errors,
      ...validateDef(s, "summary.v1.json", "run").errors,
    ];
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) problems.push("manifest.json missing");
    else {
      const { readFileSync } = await import("node:fs");
      problems.push(...validate(JSON.parse(readFileSync(manifestPath, "utf8")), "manifest.v1.json").errors);
    }
    if (problems.length) {
      failed = true;
      console.error(`${r.locale}: schema problems: ${problems.join("; ")}`);
    }
    rows.push(`${r.locale.padEnd(3)} keys=${s.counts.keys} escalated=${s.counts.escalated} cost=$${s.costUsd} models=${Object.values(s.models).join(" → ")}`);
  } catch (err) {
    failed = true;
    console.error(`${r.locale}: ${err.message}`);
  }
}

if (record && profile === "openrouter") {
  const { CONTRACT_BATCHES } = await import("../test/fixtures/contract-batches.mjs");
  const recDir = join(ROOT, "test", "fixtures", "recorded", "openrouter");
  mkdirSync(recDir, { recursive: true });
  const stages = loadModelsConfig().openrouter.stages;
  for (const [stage, batch] of Object.entries(CONTRACT_BATCHES)) {
    const slug = stages[stage === "compare" ? "judge" : stage];
    const fetchImpl = async (url, init) => {
      const res = await fetch(url, init);
      const text = await res.text();
      if (res.ok) writeFileSync(join(recDir, `${stage}.json`), JSON.stringify(JSON.parse(text), null, 2) + "\n");
      return { ok: res.ok, status: res.status, headers: res.headers, text: async () => text };
    };
    await createOpenRouterAdapter(slug, { fetchImpl })[stage](batch, { telemetry: new Telemetry() });
    rows.push(`recorded ${stage} (${slug})`);
  }
}

console.log(`smoke:${profile} → ${out}\n${rows.map((r) => `  ${r}`).join("\n")}`);
process.exit(failed ? 1 : 0);
