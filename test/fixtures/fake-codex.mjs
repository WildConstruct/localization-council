#!/usr/bin/env node
/**
 * Fake `codex` for contract / e2e tests.
 * Honors: exec, -o <file>, --output-schema <file>, stdin prompt ("-").
 * Like the real CLI outside a trusted repo, it refuses to run without
 * --skip-git-repo-check. Emits noisy JSONL so adapters must prefer -o.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { answer } from "./fake-cli-lib.mjs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 0.50.0");
  process.exit(0);
}
if (args[0] !== "exec") {
  console.error("fake-codex: expected exec");
  process.exit(2);
}
if (!args.includes("--skip-git-repo-check")) {
  console.error("Not inside a trusted directory and --skip-git-repo-check was not specified.");
  process.exit(1);
}

let outFile = null;
let schemaFile = null;
for (let i = 1; i < args.length; i++) {
  if ((args[i] === "-o" || args[i] === "--output-last-message") && args[i + 1]) outFile = args[++i];
  else if (args[i] === "--output-schema" && args[i + 1]) schemaFile = args[++i];
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  const schema = schemaFile ? readFileSync(schemaFile, "utf8") : null;
  const text = process.env.FAKE_CLI_EMPTY === "1" ? "" : answer({ prompt: stdin, schema, variant: "mock:alt" });
  if (outFile) writeFileSync(outFile, text, "utf8");
  console.log(JSON.stringify({ type: "noise", text: "WRONG_JSONL_TEXT" }));
  console.log(JSON.stringify({ type: "agent_message", text: "ALSO_WRONG" }));
  process.exit(0);
});
