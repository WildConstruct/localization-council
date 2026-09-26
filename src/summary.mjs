/**
 * The machine contract: every subcommand's --json output is one object with
 * a shared envelope (schemas/summary.v1.json).
 *
 * Exit codes:
 *   0   clean (nothing needs a human)
 *   10  escalations (run / garden) or reopen rows (tidy) exist
 *   1   runtime error
 *   2   usage error (bad flags)
 *   3   preflight failed (doctor: requested profile is not runnable)
 */

import { councilVersion } from "./config.mjs";

export const SUMMARY_SCHEMA_ID = "council.summary.v1";

export const EXIT = Object.freeze({
  CLEAN: 0,
  ERROR: 1,
  USAGE: 2,
  PREFLIGHT: 3,
  ATTENTION: 10,
});

export { UsageError } from "./errors.mjs";

/** Build a summary with the shared envelope first. */
export function envelope(command, { status, exitCode, warnings = [], errors = [], ...rest }) {
  return {
    schema: SUMMARY_SCHEMA_ID,
    command,
    councilVersion: councilVersion(),
    status,
    exitCode,
    ...rest,
    warnings,
    errors,
  };
}

/** Empty run fields so error and skipped summaries keep the same shape as full runs. */
export function emptyRunFields() {
  return {
    locale: null,
    profile: null,
    preset: null,
    providers: null,
    models: null,
    outDir: null,
    artifacts: null,
    counts: null,
    escalations: [],
    costUsd: null,
    skipped: false,
  };
}

/** Empty per-command fields, so an error summary has the same shape as a success. */
const EMPTY_FIELDS = {
  run: emptyRunFields,
  diff: () => ({ delta: null, missing: [], untranslated: [], sourceCount: null, targetCount: null }),
  tidy: () => ({
    locale: null,
    profile: null,
    preset: null,
    judge: null,
    outDir: null,
    artifacts: null,
    counts: null,
    reopen: [],
    costUsd: null,
  }),
  garden: () => ({ catalogs: null, walked: null, withDelta: null, results: [] }),
  doctor: () => ({ node: null, clis: null, keys: null, profiles: null, recommendedProfile: null }),
  version: () => ({ version: null }),
  help: () => ({ usage: null }),
  presets: () => ({ defaultStages: null, presets: [], profiles: [], precedence: "config/models.json < modelsFile < preset < per-stage model" }),
};

/** Summary for a failed command. */
export function errorSummary(command, err) {
  const exitCode = err?.exitCode ?? EXIT.ERROR;
  const base = EMPTY_FIELDS[command]?.() ?? {};
  return envelope(command, {
    status: "error",
    exitCode,
    ...base,
    errors: [{ code: err?.code || (exitCode === EXIT.USAGE ? "usage" : "error"), message: String(err?.message || err) }],
  });
}
