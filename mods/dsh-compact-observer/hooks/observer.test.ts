import { test, expect, mock } from "claude-code/testing";

const descriptor = { url: "http://127.0.0.1:12345/bridge", token: "observer-test-token", sessionId: "s1", agentId: "a1", epoch: "e1", operationId: "op1" };
const messages = [{ role: "user", text: "private summary", toolUses: [] }] as const;
function world(on: any, descriptorValue: any = descriptor, fail = false) {
  const calls: any[] = [];
  let compactCalls = 0;
  mock.env(on, descriptorValue ? { DSH_CLAUDE_COMPACT_OBSERVER: JSON.stringify(descriptorValue) } : {});
  on("env.set", () => ({ value: undefined }));
  on("session.id", () => ({ value: "c1" }));
  on("session.compact", () => { compactCalls += 1; return { messages, tokensBefore: 100, tokensAfter: 30 }; });
  on("http.fetch", (_$: any, e: any) => {
    calls.push({ body: JSON.parse(e.init.body), headers: e.init.headers });
    if (fail) throw new Error("sensitive request failure");
    return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
  });
  return { calls, count: () => compactCalls };
}

test("observer reports only structured native completion and returns the native result unchanged", async ($, on) => {
  const { calls, count } = world(on);
  const result = await $.session.compact({ trigger: "manual", messages });
  expect(result.messages).toEqual(messages);
  expect(count()).toBe(1);
  expect(calls.length).toBe(1);
  expect(calls[0].headers.authorization).toBe("Bearer observer-test-token");
  expect(calls[0].body.method).toBe("maintenance_observe");
  expect(calls[0].body.callerAgentId).toBe(null);
  expect(calls[0].body.params).toEqual({ operationId: "op1", result: { status: "succeeded", messageCount: 1, tokensBefore: 100, tokensAfter: 30 } });
  expect(JSON.stringify(calls).includes("private summary")).toBe(false);
});

test("observer does not attach a maintenance receipt to child or automatic compaction", async ($, on) => {
  const { calls, count } = world(on);
  await $.session.compact({ trigger: "auto", messages });
  await $.session.compact({ trigger: "manual", messages, agentId: "child" });
  expect(calls.length).toBe(0);
  expect(count()).toBe(2);
});

test("missing descriptor leaves native compact alone", async ($, on) => {
  const { calls } = world(on, null);
  const result = await $.session.compact({ trigger: "manual", messages });
  expect(result.messages).toEqual(messages);
  expect(calls.length).toBe(0);
});

test("observer failure neither repeats nor rewrites native compact", async ($, on) => {
  const { calls, count } = world(on, descriptor, true);
  const result = await $.session.compact({ trigger: "manual", messages });
  expect(result.messages).toEqual(messages);
  expect(count()).toBe(1);
  expect(calls.length).toBe(1);
});
