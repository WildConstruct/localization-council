import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { startFakeOpenRouter } from "./helpers/fake-openrouter.mjs";
import { createServer, TOOLS } from "../src/mcp-server.mjs";
import { validate, validateDef } from "../src/json-schema.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function client(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.COUNCIL_PROFILE;
  delete env.COUNCIL_PROVIDER;
  delete env.COUNCIL_PRESET;
  const child = spawn(process.execPath, ["src/mcp-server.mjs"], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  let nextId = 1;
  let raw = "";
  let errors = "";
  const messages = [];
  const waiters = new Map();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.stdout.on("data", (chunk) => {
    raw += chunk;
    for (;;) {
      const at = raw.indexOf("\n");
      if (at < 0) break;
      const line = raw.slice(0, at); raw = raw.slice(at + 1);
      const msg = JSON.parse(line);
      messages.push(msg);
      if (Object.prototype.hasOwnProperty.call(msg, "id") && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    }
  });
  const send = (message) => child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  const request = (method, params = {}, timeoutMs = 30_000) => {
    const id = nextId++;
    const promise = new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`timeout waiting for ${method}: ${errors}`)); }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolveReply(msg); });
    });
    send({ jsonrpc: "2.0", id, method, params });
    return promise;
  };
  return { child, messages, send, request, stop: () => { child.stdin.end(); child.kill(); } };
}

test("MCP protocol and offline tools", async (t) => {
  const c = client();
  const out = await mkdtemp(join(tmpdir(), "council-mcp-"));
  t.after(async () => { c.stop(); await rm(out, { recursive: true, force: true }); });

  let reply;
  try { reply = await c.request("initialize", { protocolVersion: "2025-11-25" }, 3_000); }
  catch (e) { t.skip(`sandbox denied child stdio: ${e.message}`); return; }
  assert.equal(reply.result.protocolVersion, "2025-11-25");
  reply = await c.request("initialize", { protocolVersion: "future" });
  assert.equal(reply.result.protocolVersion, "2025-06-18");
  const before = c.messages.length;
  c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.messages.length, before);
  assert.deepEqual((await c.request("ping")).result, {});
  const listed = (await c.request("tools/list")).result.tools;
  assert.deepEqual(listed.map((x) => x.name), ["council_list_presets", "council_doctor", "council_diff", "council_run", "council_status"]);
  assert.ok(listed.every((x) => x.inputSchema?.type === "object"));
  assert.equal((await c.request("no/such/method")).error.code, -32601);
  c.send("{bad json");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(c.messages.some((m) => m.id === null && m.error?.code === -32700));

  const presets = (await c.request("tools/call", { name: "council_list_presets", arguments: {} })).result.structuredContent;
  assert.deepEqual(presets.presets.map((p) => p.name), ["balanced", "budget", "cheapest"]);
  const diff = (await c.request("tools/call", { name: "council_diff", arguments: { source: "fixtures/toy/en.json", target: "fixtures/toy/de.json" } })).result.structuredContent;
  assert.equal(diff.delta, 10);

  const runReply = await c.request("tools/call", { name: "council_run", arguments: { catalog: "fixtures/toy/en.json", locale: "de", glossary: "fixtures/toy/glossary.de.json", profile: "mock", out }, _meta: { progressToken: "p1" } });
  const run = runReply.result.structuredContent;
  assert.equal(run.status, "escalations");
  assert.equal(run.exitCode, 10);
  assert.equal(runReply.result.isError, undefined);
  assert.ok(Object.values(run.artifacts).every((p) => p.startsWith("/") && p));
  await Promise.all(Object.values(run.artifacts).map((p) => access(p)));
  assert.ok(c.messages.some((m) => m.method === "notifications/progress" && m.params.progressToken === "p1"));
  const status = (await c.request("tools/call", { name: "council_status", arguments: { out } })).result.structuredContent;
  assert.deepEqual(status.counts, run.counts);
  assert.deepEqual(status.escalations, run.escalations);
  const bad = (await c.request("tools/call", { name: "council_run", arguments: { catalog: "fixtures/toy/en.json", locale: "de", profile: "mock", preset: "budget" } })).result;
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.errors[0].code, "usage");
});

test("MCP preset selects OpenRouter and is recorded", async (t) => {
  let fake;
  try { fake = await startFakeOpenRouter(); } catch (e) { t.skip(`local sockets unavailable: ${e.message}`); return; }
  const out = await mkdtemp(join(tmpdir(), "council-mcp-or-"));
  const c = client({ OPENROUTER_API_KEY: "test-key", OPENROUTER_BASE_URL: fake.url });
  t.after(async () => { c.stop(); await fake.close(); await rm(out, { recursive: true, force: true }); });
  try { await c.request("initialize", { protocolVersion: "2025-06-18" }, 3_000); }
  catch (e) { t.skip(`sandbox denied child stdio: ${e.message}`); return; }
  const reply = await c.request("tools/call", { name: "council_run", arguments: { catalog: "fixtures/toy/en.json", locale: "de", glossary: "fixtures/toy/glossary.de.json", preset: "budget", judgeModel: "openai/gpt-6-luna", keys: ["ui.timeline.play", "ui.comp.new"], out } });
  const summary = reply.result.structuredContent;
  assert.notEqual(summary.status, "error", JSON.stringify(summary.errors));
  assert.equal(summary.profile, "openrouter");
  assert.equal(summary.preset, "budget");
  assert.equal(summary.counts.keys, 2);
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.preset, "budget");
  assert.equal(manifest.stageModels.judge, "openai/gpt-6-luna");
  const used = new Set(fake.requests.map((r) => r.body.model));
  assert.ok(used.has("openai/gpt-6-luna"), `judge override reached OpenRouter: ${[...used]}`);
  assert.ok(used.has("deepseek/deepseek-v4.1-flash"), "budget translate model used");
  assert.deepEqual(manifest.argv.slice(0, 2), ["mcp", "council_run"]);
});

// ---- In-process tests (no child process): protocol edges, schema contract, argument mapping ----


function inProcess({ env = {}, cwd = ROOT, run } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.resume();
  const server = createServer({ stdin, stdout, stderr, env, cwd, ...(run ? { run } : {}) });
  const messages = [];
  let buf = "";
  let nextId = 1;
  const waiters = new Map();
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, at));
      buf = buf.slice(at + 1);
      messages.push(msg);
      if (waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  const send = (m) => stdin.write(`${typeof m === "string" ? m : JSON.stringify(m)}\n`);
  const request = (method, params = {}) => {
    const id = nextId++;
    const p = new Promise((r) => waiters.set(id, r));
    send({ jsonrpc: "2.0", id, method, params });
    return p;
  };
  const call = async (name, args = {}, extra = {}) => (await request("tools/call", { name, arguments: args, ...extra })).result;
  return { server, messages, send, request, call, close: () => server.close() };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function assertSummary(summary) {
  const env = validate(summary, "summary.v1.json");
  assert.ok(env.ok, env.errors.join("; "));
  if (summary.status !== "error") {
    const def = validateDef(summary, "summary.v1.json", summary.command);
    assert.ok(def.ok, def.errors.join("; "));
  }
}

test("MCP in-process: initialize, tool annotations, and schemas", async (t) => {
  const c = inProcess();
  t.after(c.close);
  const init = (await c.request("initialize", { protocolVersion: "2025-03-26" })).result;
  assert.equal(init.protocolVersion, "2025-03-26");
  assert.equal(init.serverInfo.name, "localization-council");
  assert.match(init.instructions, /never merges/);
  const { tools } = (await c.request("tools/list")).result;
  assert.equal(tools.length, TOOLS.length);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
  }
  assert.equal(tools.find((x) => x.name === "council_run").annotations.readOnlyHint, false);
  assert.ok(tools.filter((x) => x.name !== "council_run").every((x) => x.annotations.readOnlyHint));
});

test("MCP in-process: notifications and invalid messages", async (t) => {
  let runs = 0;
  const c = inProcess({ run: async () => { runs++; return {}; } });
  t.after(c.close);
  c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  c.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
  c.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "council_run", arguments: { catalog: "x", locale: "de" } } });
  c.send("");
  await tick();
  assert.equal(c.messages.length, 0, "notifications and blank lines get no reply");
  assert.equal(runs, 0, "a tools/call notification must not run anything");
  c.send({ jsonrpc: "2.0", id: 7, result: {} }); // a stray client response
  c.send({ jsonrpc: "2.0", id: 8 });
  c.send("[1,2]");
  await tick();
  assert.deepEqual(c.messages.map((m) => [m.id, m.error?.code]), [[8, -32600], [null, -32600]]);
});

test("MCP in-process: a long run does not block ping; progress uses run.log lines", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  let seen;
  const c = inProcess({
    run: async (opts) => {
      seen = opts;
      opts.onLog?.("[mock] translate ×2");
      await gate;
      return { schema: "x", command: "run", status: "clean", exitCode: 0 };
    },
  });
  t.after(c.close);
  const pending = c.request("tools/call", { name: "council_run", arguments: { catalog: "fixtures/toy/en.json", locale: "de", profile: "mock" }, _meta: { progressToken: 42 } });
  const pong = await c.request("ping");
  assert.deepEqual(pong.result, {});
  const progress = c.messages.find((m) => m.method === "notifications/progress");
  assert.deepEqual(progress.params, { progressToken: 42, progress: 1, message: "[mock] translate ×2" });
  release();
  const done = await pending;
  assert.equal(done.result.structuredContent.status, "clean");
  assert.equal(seen.catalog, join(ROOT, "fixtures/toy/en.json"));
});

test("MCP in-process: argument mapping mirrors the CLI", async (t) => {
  const calls = [];
  const fakeRun = async (opts) => { calls.push(opts); return { status: "clean" }; };
  const c = inProcess({ env: { COUNCIL_MCP_ROOT: "/ignored-because-cwd-given" }, cwd: "/data/project", run: fakeRun });
  t.after(c.close);
  await c.call("council_run", { catalog: "en.json", locale: "tr", keys: ["a", "b"], preset: "budget", judgeModel: "x/y", out: "out/tr", faceoff: true, auditJudges: ["api:jev"] });
  const o = calls[0];
  assert.equal(o.catalog, "/data/project/en.json");
  assert.equal(o.out, "/data/project/out/tr");
  assert.deepEqual(o.keys, ["a", "b"]);
  assert.equal(o.profile, "openrouter");
  assert.equal(o.preset, "budget");
  assert.equal(o.presetSource, "flag");
  assert.deepEqual(o.stageModels, { translate: undefined, backtranslate: undefined, judge: "x/y" });
  assert.deepEqual(o.auditJudges, ["api:jev"]);
  assert.equal(o.faceoff, true);
  assert.equal(o.cache, true);
  assert.deepEqual(o.argv.slice(0, 2), ["mcp", "council_run"]);
  assert.ok(o.argv.includes("--keys") && o.argv.includes("a,b"));

  const d = inProcess({ env: { COUNCIL_PROFILE: "fleet", COUNCIL_PRESET: "cheapest" }, run: fakeRun });
  t.after(d.close);
  await d.call("council_run", { catalog: "fixtures/toy/en.json", locale: "de", translateModel: "a/b" });
  assert.equal(calls[1].profile, undefined, "an env profile wins over the implied openrouter profile");
  assert.equal(calls[1].preset, "cheapest");
  assert.equal(calls[1].presetSource, "env");

  const e = inProcess({ env: { CLAUDE_PROJECT_DIR: "/proj" }, cwd: null, run: fakeRun });
  t.after(e.close);
  await e.call("council_run", { catalog: "en.json", locale: "de", profile: "mock" });
  assert.equal(calls[2].catalog, "/proj/en.json", "relative paths resolve against CLAUDE_PROJECT_DIR");
});

test("MCP in-process: usage errors come back as error summaries", async (t) => {
  const c = inProcess();
  t.after(c.close);
  for (const [name, args, pattern] of [
    ["council_run", { locale: "de" }, /requires catalog/],
    ["council_run", { catalog: "fixtures/toy/en.json", locale: "de", keys: "a,b" }, /array of strings/],
    ["council_run", { catalog: "fixtures/toy/en.json", locale: "de", bogus: 1 }, /Unknown argument "bogus"/],
    ["council_run", { catalog: "fixtures/toy/en.json", locale: "de", profile: "mock", judgeModel: "x/y" }, /only affect OpenRouter/],
    ["council_run", { catalog: "fixtures/toy/en.json", locale: "de", preset: "nope" }, /nope/],
    ["council_nope", {}, /Unknown tool/],
  ]) {
    const r = await c.call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.equal(r.structuredContent.status, "error");
    assert.equal(r.structuredContent.errors[0].code, "usage");
    assert.match(r.structuredContent.errors[0].message, pattern);
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
    assertSummary(r.structuredContent);
  }
  const missing = await c.call("council_status", { out: "/nonexistent/council-out" });
  assert.equal(missing.isError, true);
  assert.match(missing.structuredContent.errors[0].message, /manifest\.json/);
});

test("MCP in-process: real mock run, status, presets, diff, doctor all match summary.v1", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "council-mcp-ip-"));
  const c = inProcess();
  t.after(async () => { c.close(); await rm(out, { recursive: true, force: true }); });
  const run = (await c.call("council_run", { catalog: "fixtures/toy/en.json", locale: "de", glossary: "fixtures/toy/glossary.de.json", profile: "mock", keys: ["ui.timeline.play", "ui.comp.new"], out })).structuredContent;
  assertSummary(run);
  assert.equal(run.counts.keys, 2);
  assert.equal(run.outDir, out);
  for (const k of ["candidates", "backtranslations", "scores", "accepted", "escalate", "report", "manifest", "log"]) {
    assert.equal(run.artifacts[k], join(out, run.artifacts[k].split("/").pop()));
    await access(run.artifacts[k]);
  }
  const status = (await c.call("council_status", { out })).structuredContent;
  assertSummary(status);
  assert.equal(status.profile, "mock");
  assert.deepEqual(status.counts, run.counts);
  assert.deepEqual(status.artifacts, run.artifacts);
  assert.deepEqual(status.models, run.models);
  assert.deepEqual(status.escalations, run.escalations);
  assertSummary((await c.call("council_list_presets")).structuredContent);
  assertSummary((await c.call("council_diff", { source: "fixtures/toy/en.json", target: "fixtures/toy/de.json" })).structuredContent);
  assertSummary((await c.call("council_doctor", { profile: "mock" })).structuredContent);
});
