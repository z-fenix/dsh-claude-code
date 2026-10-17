import { test, expect, mock } from "claude-code/testing";
const descriptor = { url: "http://127.0.0.1:12345/bridge", token: "runtime-test-token", sessionId: "s1", agentId: "a1", epoch: "e1" };
const compose = { model: "initial", promptModel: "initial", surfaces: [], tools: [], outputStyle: null, traits: [] } as const;
const step = { turnId: "turn1", index: 0, model: "initial", messageCount: 1 };
function world(on: any, replies: any = {}, failure?: string) {
  const calls: any[] = [];
  mock.env(on, { DSH_CLAUDE_BRIDGE: JSON.stringify(descriptor) });
  on("env.set", () => ({ value: undefined }));
  on("session.id", () => ({ value: "c1" }));
  on("session.start", () => ({ cwd: "/w" }));
  on("http.fetch", (_$: any, e: any) => {
    const body = JSON.parse(e.init.body); calls.push(body);
    if (body.method === failure) return { value: { status: 503, ok: false, headers: {}, text: "sensitive failure" } };
    const defaults: any = { runtime_policy: { active: true, text: "Host plan policy" }, runtime_step: { planActive: false, routing: { model: "chosen", effort: "high" } },
      runtime_tool: { decision: "allow" }, runtime_check: { decision: "abstain" } };
    const value = body.method === "handshake" ? { protocol: 1, tools: [], capture: false, runtime: { policy: true, step: true, tools: true } }
      : replies[body.method] ?? defaults[body.method] ?? {};
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ value }) } };
  });
  return calls;
}
async function drain(stream: any) {
  const iterator = stream[Symbol.asyncIterator](); const chunks = [];
  for (;;) { const next = await iterator.next(); if (next.done) return { chunks, result: next.value }; chunks.push(next.value); }
}
function streamCore(on: any, seen: any[]) {
  on("turn.step", async function* (_$: any, e: any) {
    seen.push(e);
    yield { kind: "text", index: 0, text: "real chunk" };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return { turnId: e.turnId, index: e.index, answer: "real chunk", toolUses: [], stopReason: "end_turn", usage: null };
  });
}

test("unattributed cached prompt composition is observed, not used for dynamic Plan injection", async ($, on) => {
  const calls = world(on);
  on("prompt.compose", () => ({ sections: [{ id: "system", text: "core", scope: "shared" }] }));
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const result = await $.prompt.compose(compose);
  expect(result.sections).toEqual([{ id: "system", text: "core", scope: "shared" }]);
  expect(calls.some(x => x.method === "runtime_policy")).toBe(false);
});

test("host Plan policy is attached to the main native reminder, never a child reminder", async ($, on) => {
  const calls = world(on);
  on("prompt.attachment", (_$: any, e: any) => ({ text: e.text }));
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const input = { type: "plan_mode", text: "Native plan reminder", origin: { kind: "engine" },
    detail: { reminder: "full", planFilePath: "/w/plan.md", hasPlan: true } } as const;
  const main = await $.prompt.attachment(input);
  const child = await $.prompt.attachment({ ...input, agentId: "child" });
  expect(main.text.includes("Native plan reminder")).toBe(true);
  expect(main.text.includes("Host plan policy")).toBe(true);
  expect(child.text).toBe("Native plan reminder");
  expect(calls.filter(x => x.method === "runtime_policy").length).toBe(1);
});

test("main step rewrites model/effort and forwards the stream and result once", async ($, on) => {
  const calls = world(on); const seen: any[] = []; streamCore(on, seen);
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const output = await drain($.turn.step(step));
  expect(seen.length).toBe(1);
  expect(seen[0].model).toBe("chosen"); expect(seen[0].effort).toBe("high");
  expect(output.chunks[0].text).toBe("real chunk"); expect(output.result.answer).toBe("real chunk");
  expect(calls.filter(x => x.method === "runtime_step").length).toBe(1);
});

test("child step keeps native routing and never requests parent step control", async ($, on) => {
  const calls = world(on); const seen: any[] = []; streamCore(on, seen);
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  await drain($.turn.step({ ...step, model: "child-model", agentId: "child" }));
  expect(seen[0].model).toBe("child-model");
  expect(calls.some(x => x.method === "runtime_step")).toBe(false);
});

test("runtime step failure produces no model request rather than running the old model", async ($, on) => {
  world(on, {}, "runtime_step"); const seen: any[] = []; streamCore(on, seen);
  const notices: string[] = []; on("ui.log", (_$: any, e: any) => { notices.push(e.text); return { value: undefined }; });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const output = await drain($.turn.step(step));
  expect(seen.length).toBe(0);
  expect(output.result.usage).toBe(null);
  expect(notices).toEqual(["dsh-bridge: runtime control unavailable; request stopped."]);
});

test("native tool gate rewrites audited args, preserves result, and reports completion", async ($, on) => {
  const calls = world(on, { runtime_tool: { decision: "allow", updatedInput: { file_path: "/w/file", content: "rewritten" } } });
  const seen: any[] = []; on("tool.call", { tool: "Write" }, (_$: any, e: any) => { seen.push(e); return { deny: "fixture core stopped" }; });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const result = await $.tool.call({ tool: "Write", file_path: "/w/file", content: "old" });
  expect(seen.length).toBe(1); expect(seen[0].content).toBe("rewritten"); expect(result.deny).toBe("fixture core stopped");
  expect(calls.find(x => x.method === "runtime_tool_result").params.ok).toBe(false);
});

test("unavailable native tool gate fails closed before core execution", async ($, on) => {
  world(on, {}, "runtime_tool"); let core = 0;
  on("tool.call", { tool: "Write" }, () => { core += 1; return { deny: "fixture core" }; });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const result = await $.tool.call({ tool: "Write", file_path: "/w/file", content: "text" });
  expect(core).toBe(0); expect(result.deny.includes("bridge")).toBe(true);
});

test("tool.check only tightens a native decision", async ($, on) => {
  world(on, { runtime_check: { decision: "abstain" } });
  on("tool.check", () => ({ decision: "deny", reason: "native policy" }));
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const result = await $.tool.check({ tool: "Read", input: { file_path: "/w/file" } });
  expect(result.decision).toBe("deny"); expect(result.reason).toBe("native policy");
});

test("ExitPlanMode reviews the engine-owned plan file and rejects changes during review", async ($, on) => {
  const calls = world(on); let reads = 0; let core = 0;
  on("prompt.attachment", (_$: any, e: any) => ({ text: e.text }));
  on("fs.read", () => ({ value: ++reads === 1 ? "# Plan\nOriginal" : "# Plan\nChanged" }));
  on("tool.call", { tool: "ExitPlanMode" }, () => { core += 1; return { deny: "fixture core" }; });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  await $.prompt.attachment({ type: "plan_mode", text: "native reminder", origin: { kind: "engine" },
    detail: { reminder: "full", planFilePath: "/w/plan.md", hasPlan: true } });
  const result = await $.tool.call({ tool: "ExitPlanMode" });
  expect(core).toBe(0); expect(result.deny.includes("changed")).toBe(true);
  expect(calls.find(x => x.method === "runtime_tool").params.planText).toBe("# Plan\nOriginal");
  expect(calls.find(x => x.method === "runtime_tool_result").params.ok).toBe(false);
});
