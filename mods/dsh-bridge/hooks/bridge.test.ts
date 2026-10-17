import { test, expect, mock } from "claude-code/testing";

const descriptor = { url: "http://127.0.0.1:12345/bridge", token: "test-token", sessionId: "s1", agentId: "a1", epoch: "e1" };
const definition = { name: "get_goal", description: "Read goal", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
const compose = { model: "model", promptModel: "model", surfaces: [], tools: [], outputStyle: null, traits: [] } as const;
function world(on: any, tools: any[] = [], failGoal = false, failCapture = false, goalContent: any[] = [{ type: "text", text: '{"goal":null}' }], runtime?: any) {
  const calls: any[] = [];
  const registered: string[] = [];
  mock.env(on, { DSH_CLAUDE_BRIDGE: JSON.stringify(descriptor) });
  on("env.set", () => ({ value: undefined }));
  on("session.id", () => ({ value: "c1" }));
  on("session.start", () => ({ cwd: "/w" }));
  on("tool.register", (_$: any, e: any) => { registered.push(e.name); return { value: { tool: `mcp__dsh-bridge__${e.name}` } }; });
  on("http.fetch", (_$: any, e: any) => {
    expect(e.url).toBe(descriptor.url);
    const body = JSON.parse(e.init.body);
    calls.push(body);
    if (failGoal && body.method === "get_goal" || failCapture && body.method === "prompt_snapshot") return { value: { status: 503, ok: false, headers: {}, text: "sensitive network detail" } };
    const value = body.method === "handshake" ? { protocol: 1, tools, capture: "observed-compose", ...(runtime ? { runtime } : {}) }
      : { content: goalContent };
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ value }) } };
  });
  return { calls, registered };
}

test("blocked runtime cannot execute an already registered goal tool", async ($, on) => {
  const { calls } = world(on, [definition], false, false, [{ type: "text", text: '{"goal":null}' }], { step: true });
  on("ui.log", () => ({ value: undefined }));
  on("turn.step", async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: null, usage: null };
  });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  for await (const _chunk of $.turn.step({ turnId: "turn1", index: 0, model: "model", messageCount: 1 })) {}
  const result = await $.tool.call({ tool: "mcp__dsh-bridge__get_goal" });
  expect(typeof result.deny).toBe("string");
  expect(calls.some((call: any) => call.method === "get_goal")).toBe(false);
});

test("runtime 能力存在时 goal 工具与 prompt 捕获行为不变", async ($, on) => {
  const { calls, registered } = world(on, [definition], false, false, [{ type: "text", text: '{"goal":null}' }], { step: true, dshTools: true });
  const sections = [{ id: "system", text: "real system", scope: "shared" }] as const;
  on("prompt.compose", () => ({ sections }));
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  expect(registered).toEqual(["get_goal"]);
  expect((await $.prompt.compose(compose)).sections).toEqual(sections);
  expect(calls.some((call) => call.method === "prompt_snapshot")).toBe(true);
  const result = await $.tool.call({ tool: "mcp__dsh-bridge__get_goal", tool_use_id: "t1" });
  expect(JSON.parse(result.result as string)).toEqual({ goal: null });
});

test("compose is observed unchanged, never replaced", async ($, on) => {
  const { calls } = world(on);
  const sections = [{ id: "system", text: "real system", scope: "shared" }, { id: "environment", text: "real env", scope: "session" }] as const;
  on("prompt.compose", () => ({ sections }));
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const result = await $.prompt.compose(compose);
  expect(result.sections).toEqual(sections);
  const snapshot = calls.find((call) => call.method === "prompt_snapshot");
  expect(snapshot.params.sections).toEqual(sections);
  expect(snapshot.claudeSessionId).toBe("c1");
});

test("capture failure emits one sanitized SDK notice without changing composition", async ($, on) => {
  const { calls } = world(on, [], false, true);
  const notices: string[] = [];
  on("ui.log", (_$: any, e: any) => { notices.push(e.text); return { value: undefined }; });
  const sections = [{ id: "system", text: "unchanged", scope: "shared" }] as const;
  on("prompt.compose", () => ({ sections }));
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  expect((await $.prompt.compose(compose)).sections).toEqual(sections);
  expect((await $.prompt.compose(compose)).sections).toEqual(sections);
  expect(notices).toEqual(["dsh-bridge: prompt capture disabled (snapshot unavailable)."]);
  expect(calls.filter((call) => call.method === "prompt_snapshot").length).toBe(1);
});

test("only host definitions register and goal calls return shared domain value", async ($, on) => {
  const { calls, registered } = world(on, [definition]);
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  expect(registered).toEqual(["get_goal"]);
  const result = await $.tool.call({ tool: "mcp__dsh-bridge__get_goal", tool_use_id: "t1" });
  expect(JSON.parse(result.result as string)).toEqual({ goal: null });
  const request = calls.find((call) => call.method === "get_goal");
  expect(request.callerAgentId).toBe(null);
  expect(request.params).toEqual({});
});

test("goal output preserves MCP JSON text within the native tool output shape", async ($, on) => {
  world(on, [definition]);
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const result = await $.tool.call({ tool: "mcp__dsh-bridge__get_goal", tool_use_id: "t-output" });
  expect(typeof result.result).toBe("string");
  expect(JSON.parse(result.result as string)).toEqual({ goal: null });
});

test("goal exit context reaches the model in the same tool output instead of failing the call", async ($, on) => {
  const wrapup = '<goal_complete>\nObjective: "write it"\n</goal_complete>';
  world(on, [definition], false, false, [{ type: "text", text: '{"goal":{"phase":"complete"}}' }, { type: "text", text: wrapup }]);
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const result = await $.tool.call({ tool: "mcp__dsh-bridge__get_goal", tool_use_id: "t-wrapup" });
  expect(result.deny).toBeUndefined();
  expect(result.result).toBe(`{"goal":{"phase":"complete"}}\n${wrapup}`);
});

test("bridge failure denies goal calls without exposing network details", async ($, on) => {
  world(on, [definition], true);
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const result = await $.tool.call({ tool: "mcp__dsh-bridge__get_goal", tool_use_id: "t1" });
  expect(result.deny).toBe("DSH goal bridge failed closed.");
});

test("missing bridge fails closed for owned tools, no host request", async ($, on) => {
  mock.env(on, {});
  on("session.start", () => ({ cwd: "/w" }));
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const result = await $.tool.call({ tool: "mcp__dsh-bridge__get_goal", tool_use_id: "t1" });
  expect(result.deny).toBe("DSH goal bridge is unavailable.");
});

function maintenanceWorld(engine: any, on: any, execute = true, history = true, operation: any = { operationId: "op1", action: "compact", params: {} }) {
  const calls: any[] = [];
  const commands: string[] = [];
  let receipt: any = null;
  const clock = mock.clock(on);
  mock.env(on, { DSH_CLAUDE_BRIDGE: JSON.stringify(descriptor) });
  on("env.set", () => ({ value: undefined }));
  on("session.id", () => ({ value: "c1" }));
  on("session.messages", () => ({ value: history ? [{ role: "user", text: "fixture history", toolUses: [] }] : [] }));
  on("session.start", () => ({ cwd: "/w" }));
  on("http.fetch", (_$: any, e: any) => {
    const body = JSON.parse(e.init.body);
    calls.push(body);
    const value = body.method === "handshake" ? { protocol: 1, tools: [], capture: false,
      maintenance: operation }
      : body.method === "maintenance_claim" ? { execute, action: operation.action, params: operation.params }
      : body.method === "maintenance_result" ? receipt : {};
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ value }) } };
  });
  on("command.run", { command: "compact" }, async () => {
    commands.push("compact");
    const native = await engine.session.compact({ trigger: "manual", messages: [{ role: "user", text: "fixture history", toolUses: [] }] });
    receipt = native.skip !== undefined ? { status: "skipped", reason: "native compact skipped" }
      : { status: "succeeded", messageCount: native.messages.length,
        ...(native.tokensBefore === undefined ? {} : { tokensBefore: native.tokensBefore }),
        ...(native.tokensAfter === undefined ? {} : { tokensAfter: native.tokensAfter }) };
    return { text: "native command output is not a completion receipt" };
  });
  return { calls, clock, commands };
}

test("maintenance compact executes once without advertising tools or leaking summary", async ($, on) => {
  const { calls, clock, commands } = maintenanceWorld($, on);
  let compacts = 0;
  let registrations = 0;
  on("tool.register", () => { registrations += 1; return { value: { tool: "unexpected" } }; });
  on("session.compact", () => { compacts += 1; return { messages: [{ role: "user", text: "private summary", toolUses: [] }], tokensBefore: 100, tokensAfter: 30 }; });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  await clock.advance(1);
  expect(compacts).toBe(1);
  expect(commands).toEqual(["compact"]);
  expect(calls.some(x => x.method === "maintenance_result")).toBe(true);
  expect(registrations).toBe(0);
  expect(calls.find(x => x.method === "maintenance_complete").params).toEqual({ operationId: "op1",
    result: { status: "succeeded", messageCount: 1, tokensBefore: 100, tokensAfter: 30 } });
  expect(JSON.stringify(calls).includes("private summary")).toBe(false);
});

test("compact uses the native transcript instead of an empty last-request snapshot", async ($, on) => {
  const { calls, clock } = maintenanceWorld($, on, true, false);
  let compacts = 0;
  on("session.compact", () => { compacts += 1; return { messages: [{ role: "user", text: "summary", toolUses: [] }] }; });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  await clock.advance(1);
  expect(compacts).toBe(1);
  expect(calls.find(x => x.method === "maintenance_complete").params.result.status).toBe("succeeded");
});

test("maintenance command 模式只运行固定只读 builtin 并回报文本", async ($, on) => {
  const { calls, clock, commands } = maintenanceWorld($, on, true, true, { operationId: "op1", action: "command", params: { command: "cost" } });
  on("command.run", { command: "cost" }, () => { commands.push("cost"); return { text: "$0.12 spent" }; });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  await clock.advance(1);
  expect(commands).toEqual(["cost"]);
  expect(calls.find((x: any) => x.method === "maintenance_complete").params.result).toEqual({ status: "succeeded", text: "$0.12 spent" });
});

for (const output of [{ text: "failure", exitCode: 1 }, {}, { text: "x".repeat(9000) }]) {
  test("native command errors, empty output and oversized output are not successful reports", async ($, on) => {
    const { calls, clock } = maintenanceWorld($, on, true, true, { operationId: "op1", action: "command", params: { command: "cost" } });
    on("command.run", { command: "cost" }, () => output);
    await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
    await clock.advance(1);
    expect(calls.find((x: any) => x.method === "maintenance_complete").params.result.status === "succeeded").toBe(false);
  });
}

test("maintenance command 模式拒绝白名单外的命令，不执行也不报成功", async ($, on) => {
  const { calls, clock, commands } = maintenanceWorld($, on, true, true, { operationId: "op1", action: "command", params: { command: "rm" } });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  await clock.advance(1);
  expect(commands).toEqual([]);
  expect(calls.find((x: any) => x.method === "maintenance_complete").params.result.status).toBe("uncertain");
});

test("a claimed maintenance operation is never executed again", async ($, on) => {
  const { calls, clock } = maintenanceWorld($, on, false);
  let compacts = 0;
  on("session.compact", () => { compacts += 1; return { messages: [] }; });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  await clock.advance(1);
  expect(compacts).toBe(0);
  expect(calls.some(x => x.method === "maintenance_complete")).toBe(false);
});

test("native skip and failure are not compact success", async ($, on) => {
  const { calls, clock } = maintenanceWorld($, on);
  on("session.compact", () => ({ skip: "native compact skipped" }));
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  await clock.advance(1);
  expect(calls.find(x => x.method === "maintenance_complete").params.result).toEqual({ status: "skipped", reason: "native compact skipped" });
});

test("native compact errors report uncertainty without provider error details", async ($, on) => {
  const { calls, clock } = maintenanceWorld($, on);
  on("session.compact", () => { throw new Error("secret provider failure"); });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  await clock.advance(1);
  expect(calls.find(x => x.method === "maintenance_complete").params.result).toEqual({ status: "uncertain", reason: "native operation failed" });
  expect(JSON.stringify(calls).includes("secret provider")).toBe(false);
});
