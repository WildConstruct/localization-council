import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";

let isolatedDir = null;

/**
 * An empty per-process scratch directory used as the CLIs' working
 * directory, so an agentic CLI cannot read the consumer's catalogs (blind
 * back-translation stays blind) and repo-level config does not leak in.
 */
export function isolatedCwd() {
  if (!isolatedDir) {
    isolatedDir = mkdtempSync(join(tmpdir(), "lc-cli-"));
    process.once("exit", () => {
      try {
        rmSync(isolatedDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
  }
  return isolatedDir;
}

/**
 * Resolve a binary on PATH, or an absolute/relative path override.
 * Absolute env overrides (e.g. CODEX_CLI_BIN=/opt/codex) must work.
 */
export async function whichBin(name) {
  if (!name || typeof name !== "string") {
    throw new Error(`CLI binary name missing`);
  }
  // Absolute path, or any value containing a path separator → treat as a path.
  // Relative paths are made absolute because CLIs run in an isolated cwd.
  if (isAbsolute(name) || name.includes("/")) {
    const abs = resolvePath(name);
    try {
      await access(abs, constants.X_OK);
      return abs;
    } catch {
      throw new Error(
        `CLI binary "${name}" not found or not executable. Install it or fix the *_CLI_BIN override.`,
      );
    }
  }
  const dirs = (process.env.PATH || "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = `${dir}/${name}`;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* continue */
    }
  }
  throw new Error(
    `CLI binary "${name}" not found on PATH. Install it, or run \`council doctor\` to see which profiles this machine can run (mock and openrouter need no CLIs).`,
  );
}

/**
 * Run a CLI non-interactively via spawn (no shell — args are not interpolated).
 * @param {string} bin - absolute or bare binary path (from whichBin / env override)
 * @param {string[]} args
 * stderr is always captured and returned (and included in failure messages).
 * @param {{ cwd?: string, input?: string, timeoutMs?: number, env?: Record<string,string>, killGraceMs?: number }} opts
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
export function runCli(bin, args, opts = {}) {
  const { cwd, input, timeoutMs = 120_000, env, killGraceMs = 5_000 } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let killTimer = null;

    /**
     * Settle the promise. By default clears the main timeout.
     * Kill-grace timer is NOT cleared here on timeout reject — only on
     * process close or after SIGKILL fires (B2).
     */
    const finish = (fn, value, { clearKillTimer = true } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (clearKillTimer && killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      fn(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // Schedule SIGKILL; do NOT let finish() cancel this timer.
      killTimer = setTimeout(() => {
        killTimer = null;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, killGraceMs);
      finish(
        reject,
        new Error(
          `${bin} timed out after ${timeoutMs}ms (sent SIGTERM, then SIGKILL after ${killGraceMs}ms)\nstderr: ${stderr.slice(0, 2000)}`,
        ),
        { clearKillTimer: false },
      );
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      finish(
        reject,
        new Error(
          `Failed to spawn "${bin}": ${err.message}. Is it installed and on PATH?`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      // Always clear timers on close (including after timeout settle).
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (settled) return;
      if (code !== 0) {
        finish(
          reject,
          new Error(
            `${bin} exited ${code}${signal ? ` (signal ${signal})` : ""}\nstderr: ${stderr.slice(0, 4000)}\nstdout: ${stdout.slice(0, 1000)}`,
          ),
        );
        return;
      }
      finish(resolve, { stdout, stderr, code });
    });

    // A CLI that exits before reading stdin (bad flag, auth failure) makes the
    // write fail with EPIPE. Swallow it here: the 'close' handler reports the
    // exit code and stderr, which is the useful error.
    child.stdin.on("error", () => {});
    try {
      if (input != null) {
        child.stdin.write(input);
      }
      child.stdin.end();
    } catch (err) {
      finish(
        reject,
        new Error(`Failed writing stdin to "${bin}": ${err.message}`),
      );
    }
  });
}

/**
 * Extract plain text from common CLI JSON envelopes (best-effort).
 */
export function extractText(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj === "string") return obj;
    if (obj && obj.is_error === true) {
      throw new Error(
        `CLI JSON envelope is_error: ${obj.result || obj.error || "unknown"}`,
      );
    }
    if (typeof obj.result === "string") return obj.result;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.response === "string") return obj.response;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.translation === "string") return obj.translation;
    if (typeof obj.candidate === "string") return obj.candidate;
    if (typeof obj.backtranslation === "string") return obj.backtranslation;
    // Anthropic-ish / grok messages
    if (Array.isArray(obj.content)) {
      return obj.content
        .filter((b) => b?.type === "text" || typeof b?.text === "string")
        .map((b) => b.text)
        .join("");
    }
    if (obj.message?.content) {
      const c = obj.message.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c.map((b) => b.text || "").join("");
      }
    }
  } catch (err) {
    if (err && /CLI JSON envelope is_error/.test(err.message)) throw err;
    // plain text
  }
  return trimmed;
}

/** First x.y.z in a version string, or null. */
export function parseVersion(text) {
  const m = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Compare two x.y.z strings: -1, 0, 1. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

/**
 * Best-effort `<bin> --version`. Never throws.
 * @returns {Promise<{ raw: string|null, version: string|null }>}
 */
export async function cliVersion(bin, { timeoutMs = 15_000 } = {}) {
  try {
    const { stdout, stderr } = await runCli(bin, ["--version"], {
      timeoutMs,
      killGraceMs: 1_000,
      cwd: isolatedCwd(),
    });
    const raw = (stdout || stderr).trim().split("\n")[0] || null;
    return { raw, version: parseVersion(raw) };
  } catch {
    return { raw: null, version: null };
  }
}
