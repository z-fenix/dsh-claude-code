import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import { DshInbox } from "../lib/inbox.mjs";
import { pluginFacts, bindPluginFacts, PluginFacts } from "../lib/plugin-facts.mjs";
import { ClaudeRunControl } from "../lib/run-control.mjs";

// 防止真实 append 接受、重启却拒绝的私有事件重新进入原生日志。
test("真实 Session 的输入意图不污染原生日志，重建仍保留 steer", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-facts-restart-"));
  const previous = process.env.DSH_CLAUDE_CODE_STORE;
  process.env.DSH_CLAUDE_CODE_STORE = root;
  const first = Session.create("s-restart");
  try {
    const inbox = new DshInbox(first, { emit() {} });
    inbox.enqueue("next-step", { id: "steer-1", role: "user", content: [{ type: "text", text: "change direction" }] }, true);
    const events = first.snapshotEvents();
    assert.deepEqual(events.filter((event) => !KNOWN_SESSION_EVENT_TYPES.has(event.type)), []);
    pluginFacts(first).close();
    const reopened = Session.create(first.id, events, first.header);
    const restored = new DshInbox(reopened, { emit() {} });
    assert.deepEqual(restored.nextStep.map((message) => message.id), ["steer-1"]);
    assert.equal(restored.steers.has("steer-1"), true);
    pluginFacts(reopened).close();
  } finally {
    pluginFacts(first).close();
    if (previous === undefined) delete process.env.DSH_CLAUDE_CODE_STORE;
    else process.env.DSH_CLAUDE_CODE_STORE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("回显和打断回执只进插件台账，不进入真实 Session", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-receipts-"));
  const session = Session.create("s-receipts");
  const facts = bindPluginFacts(session, new PluginFacts(session, { root }));
  try {
    const control = new ClaudeRunControl({ ctx: {}, session, epoch: "e1", signal: new AbortController().signal, abort() {} });
    const messages = [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }] }];
    control.start({ interrupt: async () => ({ still_queued: ["u1"] }), close() {} }, await control.prepareInitial("hello", messages));
    control.handleMessage({ type: "user", isReplay: true, uuid: "u1" });
    await control.interrupt();
    assert.deepEqual(session.snapshotEvents().filter((event) => !KNOWN_SESSION_EVENT_TYPES.has(event.type)), []);
    assert.deepEqual(facts.events().filter((event) => event.type === "claude-code/input-receipt").map((event) => event.data.kind), ["acknowledged", "interrupt"]);
  } finally { facts.close(); rmSync(root, { recursive: true, force: true }); }
});
