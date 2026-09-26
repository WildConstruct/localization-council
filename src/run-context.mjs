/**
 * Per-run plumbing shared by every stage: the result cache (resumable
 * reruns), telemetry (models seen, cost), and a provider log file.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { join } from "node:path";

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Stable JSON (sorted object keys) for hashing. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Content hash of a glossary. The cache key always uses this, so an edit is never missed. */
export function glossaryHash(glossary) {
  if (!glossary) return "none";
  return `sha256:${sha256(stableStringify(glossary)).slice(0, 16)}`;
}

/** Glossary version for people: the explicit `version` field, else the content hash. */
export function glossaryVersion(glossary) {
  if (!glossary) return "none";
  if (typeof glossary.version === "string" && glossary.version) return glossary.version;
  return glossaryHash(glossary);
}

/**
 * Result cache, one JSON file per stage under <dir>. Entries are keyed on a
 * hash of stage, provider, model, prompt version, locale, glossary version,
 * catalog key, and the stage inputs (source text, candidate, …).
 */
export class ResultCache {
  constructor(dir, { enabled = true } = {}) {
    this.dir = dir;
    this.enabled = enabled && Boolean(dir);
    this.stages = new Map();
    this.dirty = new Set();
    this.hits = {};
    this.misses = {};
  }

  static keyFor(parts) {
    return sha256(stableStringify(parts));
  }

  async load(stage) {
    if (this.stages.has(stage)) return this.stages.get(stage);
    let data = {};
    if (this.enabled) {
      try {
        data = JSON.parse(await readFile(join(this.dir, `${stage}.json`), "utf8"));
      } catch {
        data = {};
      }
    }
    this.stages.set(stage, data);
    return data;
  }

  async get(stage, hash) {
    const data = await this.load(stage);
    const hit = this.enabled ? data[hash] : undefined;
    if (hit !== undefined) this.hits[stage] = (this.hits[stage] || 0) + 1;
    else this.misses[stage] = (this.misses[stage] || 0) + 1;
    return hit;
  }

  async set(stage, hash, value) {
    const data = await this.load(stage);
    data[hash] = value;
    this.dirty.add(stage);
  }

  /** Persist dirty stages (atomic rename). Call after every batch so a crash can resume. */
  async flush() {
    if (!this.enabled) return;
    await mkdir(this.dir, { recursive: true });
    for (const stage of this.dirty) {
      const file = join(this.dir, `${stage}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.stages.get(stage)), "utf8");
      await rename(tmp, file);
    }
    this.dirty.clear();
  }

  stats() {
    return { dir: this.enabled ? this.dir : null, enabled: this.enabled, hits: { ...this.hits }, misses: { ...this.misses } };
  }
}

/** Collects one record per provider call: models seen, cost, latency. */
export class Telemetry {
  constructor() {
    this.calls = [];
  }

  record(entry) {
    this.calls.push({ ...entry });
  }

  /** Aggregate by stage: requested models, resolved models, cost. */
  summary() {
    const byStage = {};
    let costUsd = 0;
    let costComplete = true;
    let successfulCalls = 0;
    for (const c of this.calls) {
      const s = (byStage[c.stage] ||= { calls: 0, costUsd: 0, requestedModels: [], resolvedModels: [], providers: [] });
      if (c.ok !== false) {
        s.calls += 1;
        successfulCalls += 1;
      }
      if (Number.isFinite(c.costUsd)) {
        s.costUsd += c.costUsd;
        costUsd += c.costUsd;
      } else {
        costComplete = false;
      }
      for (const [field, value] of [
        ["requestedModels", c.requestedModel],
        ["resolvedModels", c.resolvedModel],
        ["providers", c.provider],
      ]) {
        if (value && !s[field].includes(value)) s[field].push(value);
      }
    }
    return { calls: successfulCalls, costUsd: round6(costUsd), costComplete: this.calls.length ? costComplete : true, byStage };
  }
}

export function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Build the ctx object passed to adapters.
 * @param {{ outDir: string, cacheDir?: string|null, cache?: boolean }} opts
 */
export async function createRunContext({ outDir, cacheDir = null, cache = true, providerSalt = {}, onLog = null }) {
  await mkdir(outDir, { recursive: true });
  const logFile = join(outDir, "run.log");
  await writeFile(logFile, "", "utf8");
  const telemetry = new Telemetry();
  const resultCache = new ResultCache(cacheDir || join(outDir, ".cache"), { enabled: cache });
  let pending = Promise.resolve();
  return {
    outDir,
    telemetry,
    cache: resultCache,
    // Extra cache-key input per provider (e.g. CLI version: a CLI upgrade can change its default model).
    providerSalt,
    logFile,
    log(line) {
      const stamped = `${new Date().toISOString()} ${line}\n`;
      pending = pending.then(() => appendFile(logFile, stamped, "utf8")).catch(() => {});
      if (onLog) {
        try {
          onLog(line);
        } catch {
          // Logging observers must never interrupt a run.
        }
      }
    },
    async settle() {
      await pending;
    },
  };
}
