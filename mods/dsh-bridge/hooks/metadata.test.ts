import { test, expect, mock } from "claude-code/testing";
const descriptor = { url: "http://127.0.0.1:12345/bridge", token: "metadata-test-token", sessionId: "s1", agentId: "a1", epoch: "e1" };
function world(on: any) {
  const calls: any[] = []; let usageReads = 0;
  mock.env(on, { DSH_CLAUDE_BRIDGE: JSON.stringify(descriptor) });
  on("env.set", () => ({ value: undefined })); on("session.id", () => ({ value: "c1" }));
  on("session.start", () => ({ cwd: "/w" }));
  on("command.list", () => ({ value: [{ name: "example", description: "Example command", source: "user" }] }));
  on("session.usage", () => { usageReads += 1; return { value: { startedAt: 1, context: { window: 200000, tokens: 12, percent: 0 }, rateLimits: [] } }; });
  on("http.fetch", (_$: any, e: any) => {
    const body = JSON.parse(e.init.body); calls.push(body);
    const value = body.method === "handshake" ? { protocol: 1, tools: [], capture: false,
      runtime: { observations: true, context: true, catalog: true } } : {};
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ value }) } };
  });
  return { calls, usageReads: () => usageReads };
}
const complete = { turnId: "turn1", reason: "answer", answer: "SENSITIVE_RESPONSE", durationMs: 12, isAborted: false } as const;

test("metadata reports native spawn identity only after real spawn and preserves the result", async ($, on) => {
  const { calls } = world(on);
  on("agent.spawn", () => ({ model: "child-model", agentId: "native-child" }));
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const result = await $.agent.spawn({ prompt: "SENSITIVE_TASK", description: "task", parentModel: "main", tool_use_id: "call-child" });
  expect(result.agentId).toBe("native-child");
  const record = calls.find(x => x.method === "runtime_observe" && x.params.kind === "spawn");
  expect(record.params.nativeAgentId).toBe("native-child");
  expect(record.params.toolUseId).toBe("call-child");
  expect(JSON.stringify(calls).includes("SENSITIVE_TASK")).toBe(false);
});

test("main completion reports summary context and catalog without response text", async ($, on) => {
  const { calls, usageReads } = world(on);
  on("turn.complete", (_$: any, e: any) => ({ text: e.answer }));
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const result = await $.turn.complete(complete);
  expect(result.text).toBe("SENSITIVE_RESPONSE");
  expect(usageReads()).toBe(1);
  expect(calls.find(x => x.method === "runtime_context").params.snapshot).toEqual({ window: 200000, tokens: 12, percent: 0, estimated: true, detail: "summary", truncated: false });
  expect(calls.filter(x => x.method === "runtime_catalog").length).toBe(1);
  expect(JSON.stringify(calls).includes("SENSITIVE_RESPONSE")).toBe(false);
});

test("child completion never reads or attributes main session context", async ($, on) => {
  const { calls, usageReads } = world(on);
  on("turn.complete", (_$: any, e: any) => ({ text: e.answer }));
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  await $.turn.complete({ ...complete, agentId: "child" });
  expect(usageReads()).toBe(0);
  expect(calls.find(x => x.method === "runtime_observe").callerAgentId).toBe("child");
});

test("stored-row counters exclude queue and never transfer message content", async ($, on) => {
  const { calls } = world(on);
  on("turn.step", async function* (_$: any, e: any) {
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return { turnId: e.turnId, index: e.index, answer: "SENSITIVE_RESPONSE", toolUses: [], stopReason: "end_turn", usage: null };
  });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const row = { uuid: "row1", door: "response", origin: { kind: "model", model: "main" },
    message: { type: "assistant", role: "assistant", content: [{ type: "text", text: "SENSITIVE_ROW" }] } } as const;
  await $.session.append(row);
  await $.session.append({ ...row, uuid: "row2", door: "queue" });
  for await (const _chunk of $.turn.step({ turnId: "turn1", index: 0, model: "main", messageCount: 1 })) {}
  const record = calls.find(x => x.method === "runtime_observe" && x.params.kind === "step");
  expect(record.params.appendCount).toBe(1);
  expect(JSON.stringify(calls).includes("SENSITIVE_ROW")).toBe(false);
  expect(JSON.stringify(calls).includes("SENSITIVE_RESPONSE")).toBe(false);
});
