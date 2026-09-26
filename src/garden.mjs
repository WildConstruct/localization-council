import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, basename, join, isAbsolute } from "node:path";
import { diffCatalogFiles } from "./catalog.mjs";

/**
 * Candidate paths for a garden catalog entry (primary convention first).
 * Relative paths are tried as:
 *   <root>/<repoBasename>/<rel>
 *   <root>/<rel>
 *   resolve(rel)  (cwd-relative)
 */
export function gardenPathCandidates(root, repo, relPath) {
  if (isAbsolute(relPath)) return [relPath];
  const repoBase = basename(repo);
  return [
    join(root, repoBase, relPath),
    join(root, relPath),
    resolve(relPath),
  ];
}

/**
 * Resolve a catalog path from the garden manifest.
 * Returns the primary convention path (existence checked by caller / pickExistingPath).
 */
export function resolveGardenPath(root, repo, relPath) {
  return gardenPathCandidates(root, repo, relPath)[0];
}

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the first readable path among candidates.
 * @returns {Promise<string|null>}
 */
export async function pickExistingPath(candidates) {
  for (const p of candidates) {
    if (await exists(p)) return p;
  }
  return null;
}

/**
 * Active locale set from manifest localeTiers (if present).
 * When localeTiers.active is set, only those locales are walked.
 * Deferred / planned locales are skipped until deliberately promoted.
 * @returns {Set<string>|null} null means "no filter — walk all catalog rows"
 */
export function activeLocaleSet(data) {
  const tiers = data?.localeTiers;
  if (!tiers || typeof tiers !== "object") return null;
  if (!Array.isArray(tiers.active)) return null;
  return new Set(tiers.active.map(String));
}

/**
 * Walk a garden manifest and diff each catalog pair (dry-diff).
 *
 * Tonight: dry-diff walker only (mock-friendly). Full council walk = later.
 * When `localeTiers.active` is present, catalog rows whose `locale` is not
 * in that set are skipped (status: deferred_locale).
 *
 * @param {object} opts
 * @param {string} opts.manifest - path to garden JSON
 * @param {string} [opts.root] - checkout root (default cwd)
 * @returns {Promise<object>} summary with per-catalog delta counts
 */
export async function runGardenDryDiff({ manifest, root = process.cwd() }) {
  const absManifest = resolve(manifest);
  const data = JSON.parse(await readFile(absManifest, "utf8"));
  const rootAbs = resolve(root);
  const active = activeLocaleSet(data);
  const results = [];
  let totalMissing = 0;
  let totalUntranslated = 0;
  let cleanCount = 0;
  let errorCount = 0;
  let skippedDeferred = 0;

  for (const entry of data.repos || []) {
    const repo = entry.repo || "unknown";
    for (const cat of entry.catalogs || []) {
      const locale = cat.locale != null ? String(cat.locale) : "";
      const row = {
        repo,
        id: cat.id,
        locale,
        sourcePath: null,
        targetPath: null,
      };

      if (active && locale && !active.has(locale)) {
        row.status = "deferred_locale";
        row.note =
          "locale not in localeTiers.active — skipped until deliberately promoted";
        skippedDeferred++;
        results.push(row);
        continue;
      }

      const sourceCandidates = gardenPathCandidates(rootAbs, repo, cat.source);
      const targetCandidates = gardenPathCandidates(rootAbs, repo, cat.target);
      const sourcePath = await pickExistingPath(sourceCandidates);
      const targetPath = await pickExistingPath(targetCandidates);
      row.sourcePath = sourcePath || sourceCandidates[0];
      row.targetPath = targetPath || targetCandidates[0];

      if (!sourcePath || !targetPath) {
        row.status = "missing_files";
        row.error = `source or target not found under --root (tried ${sourceCandidates.join(" | ")} / ${targetCandidates.join(" | ")})`;
        errorCount++;
        results.push(row);
        continue;
      }

      try {
        const diff = await diffCatalogFiles(sourcePath, targetPath);
        const missing = diff.missing.length;
        const untranslated = diff.untranslated.length;
        row.sourceCount = diff.sourceCount;
        row.targetCount = diff.targetCount;
        row.missing = missing;
        row.untranslated = untranslated;
        row.delta = missing + untranslated;
        row.status = row.delta === 0 ? "CLEAN" : "DELTA";
        totalMissing += missing;
        totalUntranslated += untranslated;
        if (row.status === "CLEAN") cleanCount++;
        results.push(row);
      } catch (err) {
        row.status = "error";
        row.error = err.message;
        errorCount++;
        results.push(row);
      }
    }
  }

  const walked = results.filter((r) => r.status !== "deferred_locale");
  return {
    manifest: absManifest,
    root: rootAbs,
    localeTiers: data.localeTiers || null,
    catalogs: results.length,
    walked: walked.length,
    skippedDeferred,
    clean: cleanCount,
    withDelta: results.filter((r) => r.status === "DELTA").length,
    errors: errorCount,
    totalMissing,
    totalUntranslated,
    allClean:
      cleanCount === walked.length && errorCount === 0 && walked.length > 0,
    results,
  };
}
