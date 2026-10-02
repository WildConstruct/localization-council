/**
 * The term inventory from `council garden --mode glossary`: one row per term per catalog, so a
 * team can keep its terminology in a store it owns. Written as JSON (keep it in a repo), CSV
 * (Notion, spreadsheets) and SQL upserts (Postgres such as Neon, or SQLite). The council only
 * writes files; it never connects to a database or a workspace.
 */

import { sameTerm, keysUsingTerm } from "./glossary.mjs";
import { glossaryEntryFor, referencesFor } from "./glossary-growth.mjs";

/** Columns, in order, for CSV and SQL. */
export const INVENTORY_COLUMNS = [
  "term",
  "locale",
  "repo",
  "catalog",
  "status",
  "glossary_term",
  "suggested_term",
  "decision",
  "renderings",
  "consistent",
  "keys_seen",
  "keys_using",
  "other_apps",
  "cross_app",
  "product_meaning",
  "swept_at",
];

const fold = (s) => String(s ?? "").normalize("NFC").toLowerCase();

/**
 * Build inventory rows from per-catalog harvests.
 * @param {object[]} harvests - [{ repo, catalog, locale, enMap, glossary, references, terms, proposals }]
 * @param {string} sweptAt - ISO timestamp
 * @returns {object[]}
 */
export function inventoryRows(harvests, sweptAt) {
  const rows = new Map();
  for (const h of harvests) {
    const own = [];
    const find = (term) => own.find((r) => sameTerm(r.term, term));
    const add = (row) => {
      own.push(row);
      return row;
    };
    for (const t of h.terms ?? []) {
      add({
        term: t.source.toLowerCase(),
        status: t.status,
        renderings: (t.renderings ?? []).map((r) => `${r.term} ×${r.keys.length}`).join("; "),
        consistent: t.consistent !== false,
        keys_seen: (t.keys ?? []).length,
        keys_using: (t.affectedKeys ?? []).length,
        product_meaning: t.productMeaning ?? "",
        majority: t.renderings?.[0]?.term ?? "",
      });
    }
    for (const p of h.proposals ?? []) {
      const row =
        find(p.id) ??
        add({
          term: String(p.id).toLowerCase(),
          renderings: (p.renderings ?? []).map((r) => `${r.term} ×${r.keys.length}`).join("; "),
          consistent: p.consistent !== false,
          keys_seen: (p.keys ?? []).length,
          keys_using: (p.affectedKeys ?? []).length,
          product_meaning: p.productMeaning ?? "",
          majority: p.renderings?.[0]?.term ?? "",
        });
      row.status = p.kind === "carry_over" ? "carry_over" : "proposed";
      row.suggested_term = p.practitionerTerm ?? "";
      // The suggestion may come from the other app, so compare what this app actually shipped.
      if (p.crossApp) row.crossApp = p.crossApp;
      row.decision = p.decision ?? null;
      if (p.productMeaning) row.product_meaning = p.productMeaning;
    }
    // Every glossary entry is in the inventory, used in shipped strings or not.
    for (const e of h.glossary?.entries ?? []) {
      if (find(e.source)) continue;
      add({
        term: e.source.toLowerCase(),
        status: "in_glossary",
        renderings: "",
        consistent: true,
        keys_seen: 0,
        keys_using: keysUsingTerm(h.enMap ?? {}, [e.source]).length,
        product_meaning: e.productMeaning ?? "",
        majority: "",
      });
    }
    for (const row of own) {
      const entry = glossaryEntryFor(h.glossary, [row.term]);
      if (entry) {
        row.glossary_term = entry.practitionerTerm;
        if (entry.productMeaning) row.product_meaning = entry.productMeaning;
      }
      const refs = referencesFor([row.term], h.references);
      const mine = row.glossary_term || row.suggested_term || row.majority;
      row.other_apps = refs.map((r) => `${r.app}: ${r.practitionerTerm}`).join("; ");
      row.cross_app = !refs.length
        ? "only_here"
        : row.crossApp ?? (refs.every((r) => fold(r.practitionerTerm) === fold(mine)) ? "agrees" : "differs");
      const out = {
        term: row.term,
        locale: h.locale,
        repo: h.repo,
        catalog: String(h.catalog),
        status: row.status,
        glossary_term: row.glossary_term ?? null,
        suggested_term: row.suggested_term ?? null,
        decision: row.decision ?? null,
        renderings: row.renderings,
        consistent: row.consistent,
        keys_seen: row.keys_seen,
        keys_using: row.keys_using,
        other_apps: row.other_apps,
        cross_app: row.cross_app,
        product_meaning: row.product_meaning,
        swept_at: sweptAt,
      };
      // One row per (term, locale, repo, catalog): the upsert key.
      rows.set(JSON.stringify([out.term, out.locale, out.repo, out.catalog]), out);
    }
  }
  return [...rows.values()].sort(
    (a, b) => a.locale.localeCompare(b.locale) || a.term.localeCompare(b.term) || a.repo.localeCompare(b.repo) || a.catalog.localeCompare(b.catalog),
  );
}

/**
 * Terms approved in two or more catalogs' glossaries for the same locale with different
 * practitioner terms. Sometimes that's right (the term means something else in each app); a person
 * should know either way.
 */
export function crossAppConflicts(rows) {
  const byTerm = new Map();
  for (const r of rows) {
    if (!r.glossary_term) continue;
    const k = JSON.stringify([r.locale, r.term]);
    if (!byTerm.has(k)) byTerm.set(k, []);
    byTerm.get(k).push(r);
  }
  const out = [];
  for (const group of byTerm.values()) {
    const terms = new Set(group.map((r) => fold(r.glossary_term)));
    if (terms.size > 1) {
      out.push({
        term: group[0].term,
        locale: group[0].locale,
        apps: group.map((r) => ({ repo: r.repo, catalog: r.catalog, glossaryTerm: r.glossary_term })),
      });
    }
  }
  return out;
}

/** A CSV cell: quoted when needed, and never read as a spreadsheet formula. */
function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The inventory as CSV (header row first). Notion imports it as a database. */
export function inventoryCsv(rows) {
  const lines = [INVENTORY_COLUMNS.join(",")];
  for (const r of rows) lines.push(INVENTORY_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\n") + "\n";
}

/** A SQL literal. Strings are single-quoted with quotes doubled; NUL can't be stored, so it's dropped. */
function sqlLiteral(v) {
  if (v == null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${String(v).replaceAll("\u0000", "").replaceAll("'", "''")}'`;
}

/**
 * The inventory as SQL: CREATE TABLE IF NOT EXISTS plus one upsert per row, in a transaction.
 * Runs unchanged on Postgres (including Neon) and SQLite 3.24+. Re-running a newer sweep updates
 * rows in place; a row whose swept_at is older than the latest sweep is a term no longer seen.
 */
export function inventorySql(rows, { table = "council_terms", sweptAt = rows[0]?.swept_at ?? "" } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Invalid table name "${table}"`);
  const key = ["term", "locale", "repo", "catalog"];
  const updates = INVENTORY_COLUMNS.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`);
  const out = [
    `-- Localization Council term inventory (council garden --mode glossary), swept ${sweptAt}.`,
    '-- Postgres or Neon: psql "$DATABASE_URL" -f inventory.sql',
    "-- SQLite 3.24+:     sqlite3 terms.db < inventory.sql",
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    "  term TEXT NOT NULL,",
    "  locale TEXT NOT NULL,",
    "  repo TEXT NOT NULL,",
    "  catalog TEXT NOT NULL,",
    "  status TEXT NOT NULL,",
    "  glossary_term TEXT,",
    "  suggested_term TEXT,",
    "  decision TEXT,",
    "  renderings TEXT,",
    "  consistent BOOLEAN,",
    "  keys_seen INTEGER,",
    "  keys_using INTEGER,",
    "  other_apps TEXT,",
    "  cross_app TEXT,",
    "  product_meaning TEXT,",
    "  swept_at TEXT NOT NULL,",
    `  PRIMARY KEY (${key.join(", ")})`,
    ");",
    "BEGIN;",
  ];
  for (const r of rows) {
    out.push(
      `INSERT INTO ${table} (${INVENTORY_COLUMNS.join(", ")}) VALUES (${INVENTORY_COLUMNS.map((c) => sqlLiteral(r[c])).join(", ")})`,
      `  ON CONFLICT (${key.join(", ")}) DO UPDATE SET ${updates.join(", ")};`,
    );
  }
  out.push("COMMIT;");
  return out.join("\n") + "\n";
}
