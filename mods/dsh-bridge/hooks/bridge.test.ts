import { test, expect, mock } from "claude-code/testing";

const descriptor = { url: "http://127.0.0.1:12345/bridge", token: "test-token", sessionId: "s1", agentId: "a1", epoch: "e1" };
const definition = { name: "get_goal", description: "Read goal", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
const compose = { model: "model", promptModel: "model", surfaces: [], tools: [], outputStyle: null, traits: [] } as const;
function world(on: any, tools: any[] = [], failGoal = false, failCapture = false, goalContent: any[] = [{ type: "text", text: '{"goal":null}' }]) {
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
    const value = body.method === "handshake" ? { protocol: 1, tools, capture: "observed-compose" }
      : { content: goalContent };
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ value }) } };
  });
  return { calls, registered };
}

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
