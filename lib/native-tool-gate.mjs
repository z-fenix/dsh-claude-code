// Mod 与 SDK 权限回调共享同一 tool-use 身份的 gate；不扩大宿主工具执行面。
import { createHash } from "node:crypto";
import { dispatchHostToolGate } from "./host-tool-gate.mjs";
import { readOnlyDenial } from "./approval.mjs";
import { readPermission } from "./permission.mjs";
import { readSessionEvents } from "./session-events.mjs";
import { pluginFacts } from "./plugin-facts.mjs";
import { validateToolRewrite, canonicalJson } from "../mods/dsh-bridge/hooks/rewrite.mjs";
const hash = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const deny = (reason) => ({ kind: "deny", reason });
const RESERVED = new Set(["tool", "tool_use_id", "agentId", "callerAgentId", "consent", "requestMeta"]);

export function createNativeToolGate({ ctx, agent, session, signal, config = {}, epoch }) {
  const calls = new Map();
  let closed = false;
  const currentDenial = (name) => readOnlyDenial(name, { ...readPermission(readSessionEvents(session)), readOnlyBash: config.readOnlyBash });
  const matches = (entry, call) => entry && entry.toolName === call.toolName && entry.hashes.has(hash(call.input ?? {}));
  const record = (data) => pluginFacts(session).append("claude-code/tool-lifecycle", { epoch: typeof epoch === "function" ? epoch() : epoch, ...data });
  async function prepare(call) {
    if (closed || signal?.aborted || call.signal?.aborted || typeof call.callId !== "string" || !call.callId || call.callId.length > 256) return { gate: deny("Native tool call has no live identity") };
    const input = call.input ?? {};
    let entry = calls.get(call.callId);
    if (entry && (!matches(entry, call) || entry.callerAgentId !== (call.callerAgentId ?? null))) return { gate: deny("Native tool call identity conflict") };
    if (!entry) {
      if (calls.size >= 4096) return { gate: deny("Native tool call budget exhausted") };
      entry = { toolName: call.toolName, callerAgentId: call.callerAgentId ?? null, hashes: new Set([hash(input)]), approvedOnce: false, logged: false };
      entry.prepared = Promise.resolve().then(async () => {
        let updated = structuredClone(input);
        const gate = entry.callerAgentId !== null ? { kind: "allow" }
          : await dispatchHostToolGate(ctx, agent, { toolName: call.toolName, input: updated, callId: call.callId, signal: call.signal ?? signal });
        if (["deny", "cancel"].includes(gate.kind)) return { gate };
        if (!updated || typeof updated !== "object" || Array.isArray(updated) || Object.keys(updated).some(key => RESERVED.has(key))) return { gate: deny("Host tool rewrite contains reserved identity fields") };
        updated = validateToolRewrite(call.toolName, input, updated);
        const digest = hash(updated);
        entry.hashes.add(digest);
        return { gate, ...(digest === hash(input) ? {} : { updatedInput: updated }) };
      }).catch(() => ({ gate: deny("Native host tool gate failed") }));
      calls.set(call.callId, entry);
    }
    const result = await entry.prepared;
    const denial = currentDenial(call.toolName);
    if (!entry.logged) {
      try {
        record({ phase: "prepared", toolName: call.toolName, callId: call.callId, callerAgentId: entry.callerAgentId,
          decision: denial ? "deny" : result.gate.kind });
        entry.logged = true;
      } catch { return { gate: deny("Native tool audit unavailable") }; }
    }
    return { ...result, ...(denial ? { denial } : {}) };
  }
  return {
    prepare,
    async forPermission(call) {
      if (closed || signal?.aborted || call.signal?.aborted) return deny("Native tool gate is closed or cancelled");
      const entry = calls.get(call.callId);
      // 身份必须先由引擎固定的 Mod 事件确认；SDK 回调没有 child 归属，不能自行猜成 main。
      if (!entry) return deny("Native tool permission requires prior Mod identity evidence");
      if (!matches(entry, call)) return deny("Native tool permission identity conflict");
      const result = await entry.prepared;
      return entry.approvedOnce ? { kind: "allow", approvedOnce: true } : result.gate;
    },
    approveOnce(call) {
      const entry = calls.get(call.callId);
      if (!matches(entry, call)) throw new Error("Native approval identity conflict");
      entry.approvedOnce = true;
    },
    close() { closed = true; calls.clear(); },
    observe({ toolName, callId, callerAgentId = null, ok, isReadOnly }) {
      if (closed) return;
      const entry = calls.get(callId);
      if (!entry || entry.toolName !== toolName || entry.callerAgentId !== callerAgentId || entry.completed) return;
      record({ phase: "completed", toolName, callId, callerAgentId, ok: ok === true, ...(isReadOnly === true ? { isReadOnly: true } : {}) });
      entry.completed = true;
    },
  };
}
