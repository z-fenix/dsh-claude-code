import { test, expect, mock } from "claude-code/testing";
const descriptor = { url: "http://127.0.0.1:12345/bridge", token: "dsh-tools-test-token", sessionId: "s1", agentId: "a1", epoch: "e1" };
const definition = { name: "present", description: "Present files", inputSchema: { type: "object", properties: { files: { type: "array", items: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }, required: ["files"] } };
function world(on: any, initial: any[] = [definition], result: any = { content: [{ type: "text", text: "delivered" }], isError: false }) {
  const calls: any[] = []; const registered: any[] = []; let current = initial; let broken = false;
  mock.env(on, { DSH_CLAUDE_BRIDGE: JSON.stringify(descriptor) });
  on("env.set", () => ({ value: undefined })); on("session.id", () => ({ value: "c1" }));
  on("session.start", () => ({ cwd: "/w" }));
  on("tool.register", (_$: any, e: any) => { registered.push(e); return { value: { tool: `mcp__dsh-bridge__${e.name}` } }; });
  on("http.fetch", (_$: any, e: any) => {
    const body = JSON.parse(e.init.body); calls.push(body);
    const value = body.method === "handshake" ? { protocol: 1, tools: [], dshTools: current, capture: false, runtime: { step: true, dshTools: true } }
      : body.method === "runtime_step" ? { planActive: false, routing: broken ? { model: 42 } : {}, tools: current }
      : body.method === "runtime_dsh" ? result : {};
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ value }) } };
  });
  on("turn.step", async function* (_$: any, e: any) {
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: null };
  });
  return { calls, registered, set: (values: any[]) => { current = values; }, block: () => { broken = true; } };
}
async function step($: any, index = 0) { for await (const _chunk of $.turn.step({ turnId: "turn1", index, model: "model", messageCount: 1 })) {} }

test("DSH Mod tool registers only host-reviewed names and carries the real tool-use identity", async ($, on) => {
  const { calls, registered } = world(on);
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  expect(registered.map(x => x.name)).toEqual(["present"]);
  const result = await $.tool.call({ tool: "mcp__dsh-bridge__present", files: [{ path: "report.txt" }] });
  expect(result.result).toBe("delivered");
  const request = calls.find(x => x.method === "runtime_dsh");
  expect(request.callerAgentId).toBe(null);
  expect(request.params.name).toBe("present");
  expect(request.params.callId.length > 0).toBe(true);
  expect(request.params.args).toEqual({ files: [{ path: "report.txt" }] });
});

test("dynamic registration handles empty/add/update and denies removed cached tools", async ($, on) => {
  const state = world(on, []);
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  expect(state.registered.length).toBe(0);
  state.set([definition]); await step($);
  expect(state.registered.length).toBe(1);
  await step($, 1); expect(state.registered.length).toBe(1);
  state.set([{ ...definition, description: "Updated description" }]); await step($, 2);
  expect(state.registered.length).toBe(2);
  expect(state.registered[1].description).toBe("Updated description");
  state.set([]); await step($, 3);
  const removed = await $.tool.call({ tool: "mcp__dsh-bridge__present", files: [{ path: "report.txt" }] });
  expect(removed.deny.includes("unavailable")).toBe(true);
  expect(state.calls.some(x => x.method === "runtime_dsh")).toBe(false);
});

test("blocked runtime cannot execute an otherwise registered DSH tool", async ($, on) => {
  const state = world(on);
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  state.block(); await step($);
  const result = await $.tool.call({ tool: "mcp__dsh-bridge__present", files: [] });
  expect(typeof result.deny).toBe("string");
  expect(state.calls.some(x => x.method === "runtime_dsh")).toBe(false);
});

test("unaudited definition cannot register a callable tool", async ($, on) => {
  const state = world(on, [{ ...definition, name: "bash" }]);
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  expect(state.registered.length).toBe(0);
  const result = await $.tool.call({ tool: "mcp__dsh-bridge__present", files: [] });
  expect(result.deny.includes("unavailable")).toBe(true);
});

test("DSH result preserves all text/structured blocks and domain errors are explicit", async ($, on) => {
  world(on, [definition], { content: [{ type: "text", text: "first" }, { type: "resource_link", uri: "fixture://result", name: "fixture" }], isError: true });
  await $.session.start({ cwd: "/w", surface: null, isInteractive: false });
  const result = await $.tool.call({ tool: "mcp__dsh-bridge__present", files: [] });
  expect(result.deny.includes("first")).toBe(true);
  expect(result.deny.includes("fixture://result")).toBe(true);
  expect(result.deny.includes("returned an error")).toBe(true);
});
