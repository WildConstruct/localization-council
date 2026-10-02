/**
 * `council garden --mode glossary`: sweep every catalog in a garden manifest to discover what
 * belongs in each app's glossary.
 *
 * Each catalog is harvested like `council glossary harvest`, with the other catalogs' glossaries
 * for the same locale as references: a term one app already approved pre-fills the proposal in
 * another app (the term and its rejected renderings, never the meaning), and is proposed there
 * as soon as that app's English uses it, even before anything ships. A missing target catalog
 * isn't an error here: a new locale gets its head start from the other apps.
 *
 * Output under --out: a proposals folder per catalog (<owner>/<repo>/<id>/<locale>/), and the
 * garden-wide term inventory as inventory.json, inventory.csv and inventory.sql, plus GLOSSARY.md.
 * Nothing is merged and no glossary is edited.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { activeLocaleSet, gardenPathCandidates, pickExistingPath } from "./garden.mjs";
import { loadCatalog } from "./catalog.mjs";
import { loadGlossary } from "./glossary.mjs";
import { resolveExtractor, harvestCatalog, DEFAULT_MIN_KEYS } from "./glossary-growth.mjs";
import { inventoryRows, inventoryCsv, inventorySql, crossAppConflicts } from "./term-inventory.mjs";
import { createAdapter } from "./providers/resolve.mjs";
import { createRunContext } from "./run-context.mjs";
import { toolVersions } from "./doctor.mjs";
import { councilVersion, councilCheckoutWarning } from "./config.mjs";
import { envelope, EXIT, UsageError } from "./summary.mjs";
import { numberOption } from "./options.mjs";

/** Resolve every manifest row: paths, glossary, and whether it is walked. */
async function resolveRows(data, rootAbs) {
  const active = activeLocaleSet(data);
  const rows = [];
  for (const entry of data.repos || []) {
    const repo = entry.repo || "unknown";
    for (const cat of entry.catalogs || []) {
      const locale = cat.locale != null ? String(cat.locale) : "";
      const row = { repo, id: String(cat.id ?? ""), locale, sourcePath: null, targetPath: null, glossaryPath: null };
      rows.push(row);
      if (active && locale && !active.has(locale)) {
        row.status = "deferred_locale";
        continue;
      }
      const sourceCandidates = gardenPathCandidates(rootAbs, repo, cat.source);
      row.sourcePath = await pickExistingPath(sourceCandidates);
      if (!row.sourcePath) {
        row.status = "missing_files";
        row.error = `source not found under --root (tried ${sourceCandidates.join(" | ")})`;
        continue;
      }
      // No target yet is fine: nothing has shipped, but other apps' glossaries can still help.
      row.targetPath = cat.target ? await pickExistingPath(gardenPathCandidates(rootAbs, repo, cat.target)) : null;
      if (cat.glossary) {
        const candidates = gardenPathCandidates(rootAbs, repo, cat.glossary);
        row.glossaryPath = await pickExistingPath(candidates);
        // Declared but not there yet: `council glossary apply` starts it at this path.
        row.glossaryTarget = row.glossaryPath ?? candidates[0];
      }
      row.status = "walk";
    }
  }
  return rows;
}

/** A readable name per glossary file: the repo, or repo:path when a repo has several for a locale. */
function glossaryNames(rows, rootAbs) {
  const names = new Map();
  const byRepoLocale = new Map();
  for (const r of rows) {
    if (r.status !== "walk" || !r.glossaryPath) continue;
    const k = JSON.stringify([r.repo, r.locale]);
    if (!byRepoLocale.has(k)) byRepoLocale.set(k, new Set());
    byRepoLocale.get(k).add(r.glossaryPath);
  }
  for (const r of rows) {
    if (r.status !== "walk" || !r.glossaryPath || names.has(r.glossaryPath)) continue;
    const several = byRepoLocale.get(JSON.stringify([r.repo, r.locale])).size > 1;
    names.set(r.glossaryPath, several ? `${r.repo}:${relative(rootAbs, r.glossaryPath)}` : r.repo);
  }
  return names;
}

function renderGardenReport({ name, rows, results, conflicts, inventoryPaths }) {
  const lines = [`# Glossary sweep${name ? `: ${name}` : ""}`, ""];
  const withProposals = results.filter((r) => r.proposals > 0);
  lines.push(
    withProposals.length
      ? `${withProposals.length} catalog(s) have glossary proposals for a person. Nothing is enforced until a person approves it.`
      : "No catalog has anything new for its glossary.",
    "",
    "| Catalog | Locale | Proposals | From other apps | Terms seen | Report |",
    "|---------|--------|----------:|----------------:|-----------:|--------|",
    ...results.map(
      (r) =>
        `| \`${r.repo}\` ${r.id} | ${r.locale} | ${r.proposals ?? "—"} | ${r.carryOver ?? "—"} | ${r.terms ?? "—"} | ${r.report ? `\`${r.report}\`` : r.error || r.status} |`,
    ),
    "",
  );
  if (conflicts.length) {
    lines.push(
      "## Approved differently across apps",
      "",
      "Fine when the term means something different in each app. Otherwise one glossary should change.",
      "",
      ...conflicts.map((c) => `- **${c.term}** (${c.locale}): ${c.apps.map((a) => `\`${a.repo}\` ${a.catalog} → ${a.glossaryTerm}`).join("; ")}`),
      "",
    );
  }
  const rowsByStatus = (s) => rows.filter((r) => r.status === s).length;
  lines.push(
    "## Term inventory",
    "",
    `${rows.length} term rows (${rowsByStatus("in_glossary")} in a glossary, ${rowsByStatus("proposed")} proposed, ` +
      `${rowsByStatus("carry_over")} from other apps, ${rowsByStatus("below_min_keys")} seen too rarely to propose yet).`,
    "",
    `- \`${inventoryPaths.json}\`: keep it in a repo you own`,
    `- \`${inventoryPaths.csv}\`: import into Notion as a database, or a spreadsheet`,
    `- \`${inventoryPaths.sql}\`: \`psql "$DATABASE_URL" -f inventory.sql\` (Postgres, Neon) or \`sqlite3 terms.db < inventory.sql\``,
    "",
    "See docs/glossary.md#keep-the-term-inventory for each option.",
    "",
  );
  return lines.join("\n");
}

/**
 * Run the glossary sweep and return the garden summary.
 * @param {object} opts - manifest, root, out, minKeys, profile/provider/mock/extractor/preset/models, cache, cacheDir, fetchImpl, argv
 */
export async function runGardenGlossary(opts) {
  const startedAt = new Date();
  const sweptAt = startedAt.toISOString();
  if (!opts.manifest) throw new UsageError("garden requires --manifest");
  const absManifest = resolve(opts.manifest);
  let data;
  try {
    data = JSON.parse(await readFile(absManifest, "utf8"));
  } catch (err) {
    throw new UsageError(`Can't read --manifest ${opts.manifest}: ${err.message}`);
  }
  const rootAbs = resolve(opts.root || process.cwd());
  const { models, run, extractorId, preset, stageModels, warnings } = resolveExtractor(opts);
  const minKeys = numberOption(opts.minKeys, "--min-keys", DEFAULT_MIN_KEYS, { min: 1, integer: true });
  const outDir = resolve(opts.out || "./scores/garden-glossary");
  const placement = councilCheckoutWarning(outDir, "--out");
  if (placement) warnings.push(placement);
  await mkdir(outDir, { recursive: true });

  const rows = await resolveRows(data, rootAbs);
  const glossaries = new Map();
  for (const r of rows) {
    if (r.status !== "walk" || !r.glossaryPath || glossaries.has(r.glossaryPath)) continue;
    try {
      glossaries.set(r.glossaryPath, await loadGlossary(r.glossaryPath));
    } catch (err) {
      glossaries.set(r.glossaryPath, err);
    }
  }
  const names = glossaryNames(rows, rootAbs);

  const tools = await toolVersions(new Set([extractorId]), models);
  const providerSalt = Object.fromEntries(
    Object.values(tools.cli).map((t) => [`cli:${t.name}`, `${t.name}@${t.version ?? "unknown"}`]),
  );
  const adapter = createAdapter(extractorId, { models, fetchImpl: opts.fetchImpl });

  const results = [];
  const harvests = [];
  let costUsd = 0;
  let costReported = false;
  for (const r of rows) {
    const result = { repo: r.repo, id: r.id, locale: r.locale, status: r.status };
    results.push(result);
    if (r.status !== "walk") {
      if (r.error) result.error = r.error;
      continue;
    }
    const glossary = r.glossaryPath ? glossaries.get(r.glossaryPath) : null;
    try {
      if (glossary instanceof Error) throw new Error(`glossary ${r.glossaryPath}: ${glossary.message}`);
      if (glossary && glossary.locale !== r.locale) {
        throw new Error(`glossary ${r.glossaryPath} is for "${glossary.locale}", not "${r.locale}"`);
      }
      const references = [...glossaries.entries()]
        .filter(([path, g]) => path !== r.glossaryPath && !(g instanceof Error) && g.locale === r.locale)
        .map(([path, g]) => ({ name: names.get(path), path, glossary: g }));
      const enMap = await loadCatalog(r.sourcePath);
      const localeMap = r.targetPath ? await loadCatalog(r.targetPath) : {};
      const rowOut = join(outDir, ...r.repo.split("/").filter(Boolean), r.id || "catalog", r.locale);
      await mkdir(rowOut, { recursive: true });
      const ctx = await createRunContext({ outDir: rowOut, cacheDir: opts.cacheDir ? join(resolve(opts.cacheDir), ...r.repo.split("/"), r.id, r.locale) : null, cache: opts.cache !== false, providerSalt });
      let h;
      try {
        h = await harvestCatalog({
          enMap,
          localeMap,
          locale: r.locale,
          glossary,
          glossaryPath: r.glossaryTarget ?? null,
          references,
          adapter,
          extractorId,
          ctx,
          outDir: rowOut,
          minKeys,
        });
      } finally {
        await ctx.settle();
      }
      const t = ctx.telemetry.summary();
      if (t.calls) {
        costUsd += t.costUsd;
        costReported = true;
      }
      harvests.push({ repo: r.repo, catalog: r.id, locale: r.locale, enMap, glossary, references, terms: h.terms, proposals: h.proposals });
      Object.assign(result, {
        status: h.proposals.length ? "PROPOSALS" : "CLEAN",
        proposals: h.proposals.length,
        carryOver: h.counts.carryOver,
        terms: h.counts.terms,
        pairs: h.counts.pairs,
        targetMissing: !r.targetPath,
        glossary: r.glossaryTarget ?? null,
        outDir: rowOut,
        report: h.artifacts.report,
        proposalsFile: h.artifacts.proposals,
      });
    } catch (err) {
      result.status = "error";
      result.error = String(err?.message || err);
    }
  }

  const inventory = inventoryRows(harvests, sweptAt);
  const conflicts = crossAppConflicts(inventory);
  const artifacts = {
    inventory: join(outDir, "inventory.json"),
    csv: join(outDir, "inventory.csv"),
    sql: join(outDir, "inventory.sql"),
    report: join(outDir, "GLOSSARY.md"),
  };
  await writeFile(
    artifacts.inventory,
    JSON.stringify(
      {
        schema: "council.term-inventory.v1",
        sweptAt,
        councilVersion: councilVersion(),
        manifest: absManifest,
        profile: run.profile,
        preset,
        stageModels,
        extractor: extractorId,
        model: adapter.describe("terms").model,
        minKeys,
        costUsd: costReported ? Math.round(costUsd * 1e6) / 1e6 : null,
        conflicts,
        rows: inventory,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(artifacts.csv, inventoryCsv(inventory), "utf8");
  await writeFile(artifacts.sql, inventorySql(inventory, { sweptAt }), "utf8");
  await writeFile(
    artifacts.report,
    renderGardenReport({ name: data.name, rows: inventory, results, conflicts, inventoryPaths: { json: artifacts.inventory, csv: artifacts.csv, sql: artifacts.sql } }),
    "utf8",
  );

  const walked = results.filter((r) => r.status !== "deferred_locale");
  const errors = results.filter((r) => r.error);
  const withProposals = results.filter((r) => r.status === "PROPOSALS").length;
  const count = (s) => inventory.filter((r) => r.status === s).length;
  return envelope("garden", {
    status: errors.length ? "errors" : withProposals ? "proposals" : "clean",
    exitCode: errors.length ? EXIT.ERROR : withProposals ? EXIT.ATTENTION : EXIT.CLEAN,
    mode: "glossary",
    manifest: absManifest,
    root: rootAbs,
    profile: run.profile,
    extractor: extractorId,
    outDir,
    catalogs: results.length,
    walked: walked.length,
    withDelta: null,
    withProposals,
    artifacts,
    counts: {
      terms: inventory.length,
      inGlossary: count("in_glossary"),
      proposed: count("proposed"),
      carryOver: count("carry_over"),
      belowMinKeys: count("below_min_keys"),
      declined: count("declined"),
      conflicts: conflicts.length,
    },
    costUsd: costReported ? Math.round(costUsd * 1e6) / 1e6 : null,
    results,
    warnings,
    errors: errors.map((r) => ({ code: r.status, message: `${r.repo} ${r.id} (${r.locale}): ${r.error}` })),
  });
}
