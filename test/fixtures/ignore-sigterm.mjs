#!/usr/bin/env node
/**
 * Fixture: ignore SIGTERM so runCli must escalate to SIGKILL (B2).
 * Writes pid to argv[2] if provided; writes "alive" heartbeat until death.
 */
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
const markerFile = process.argv[3];
if (pidFile) writeFileSync(pidFile, String(process.pid), "utf8");

process.on("SIGTERM", () => {
  if (markerFile) {
    try {
      writeFileSync(markerFile, "sigterm-ignored", "utf8");
    } catch {
      /* ignore */
    }
  }
  // deliberately ignore — stay alive until SIGKILL
});

setInterval(() => {
  if (markerFile) {
    try {
      writeFileSync(markerFile + ".beat", String(Date.now()), "utf8");
    } catch {
      /* ignore */
    }
  }
}, 50);
