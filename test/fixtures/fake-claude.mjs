#!/usr/bin/env node
/**
 * Fake `claude` for contract / e2e tests.
 * Enforces the hardened flags (-p, --output-format json, tool deny,
 * --permission-mode); prompt on stdin; replies with a recorded-shape
 * result envelope (subtype, is_error, total_cost_usd, modelUsage).
 */
import { writeFileSync } from "node:fs";
import { answer } from "./fake-cli-lib.mjs";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const val = (flag) => (has(flag) ? args[args.indexOf(flag) + 1] : null);
if (has("--version")) {
  console.log("2.1.300 (Claude Code)");
  process.exit(0);
}
for (const [cond, msg] of [
  [has("-p"), "missing -p"],
  [val("--output-format") === "json", "expected --output-format json"],
  [has("--disallowedTools"), "expected --disallowedTools"],
  [has("--permission-mode"), "expected --permission-mode"],
]) {
  if (!cond) {
    console.error(`fake-claude: ${msg}`);
    process.exit(2);
  }
}

const logArgs = process.env.FAKE_CLAUDE_ARGS_LOG;
if (logArgs) writeFileSync(logArgs, JSON.stringify(args), "utf8");

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLI_EMPTY === "1") {
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "" }));
    process.exit(0);
  }
  const system = val("--system-prompt") || "";
  const text = answer({ prompt: `${system}\n${stdin}`, schema: val("--json-schema"), variant: "mock" });
  const model = val("--model") || "claude-default";
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      total_cost_usd: 0.0012,
      modelUsage: { [model]: { inputTokens: 40, outputTokens: 8 } },
    }),
  );
  process.exit(0);
});
