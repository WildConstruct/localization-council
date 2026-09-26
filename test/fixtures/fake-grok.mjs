#!/usr/bin/env node
/**
 * Fake `grok` for contract / e2e tests.
 * Honors: -p <prompt>, --output-format json, --json-schema <schema>.
 */
import { answer } from "./fake-cli-lib.mjs";

const args = process.argv.slice(2);
const val = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
if (args[0] === "--version") {
  console.log("grok 1.0.40");
  process.exit(0);
}
const prompt = val("-p");
if (prompt == null || val("--output-format") !== "json") {
  console.error("fake-grok: expected -p <prompt> --output-format json");
  process.exit(2);
}
const text = process.env.FAKE_CLI_EMPTY === "1" ? "" : answer({ prompt, schema: val("--json-schema"), variant: "mock:third" });
console.log(JSON.stringify({ role: "assistant", content: text }));
