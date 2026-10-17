// 一次维护只发一张执行许可；完成凭据先落盘，网络重试不重复副作用。
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

const idSchema = z.string().min(1).max(128);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const compactResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), messageCount: count.min(1), tokensBefore: count.optional(), tokensAfter: count.optional() }),
  z.strictObject({ status: z.enum(["skipped", "failed", "uncertain"]), reason: z.string().min(1).max(1024) }),
]);
const commandResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), text: z.string().max(8192) }),
  z.strictObject({ status: z.enum(["skipped", "failed", "uncertain"]), reason: z.string().min(1).max(1024) }),
]);
/** 每个 action 的入参与结果形状；新增 action 必须同时补齐这两项与 Mod driver 分支。 */
const ACTIONS = {
  compact: { params: z.strictObject({}), result: compactResult, receipt: true },
  command: { params: z.strictObject({ command: z.enum(["status", "cost"]) }), result: commandResult, receipt: false },
};

export function createNativeOperation({ id, action, params = {}, claudeSessionId, record }) {
  idSchema.parse(id);
  idSchema.parse(claudeSessionId);
  const spec = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
  if (spec === undefined || typeof record !== "function") throw new TypeError("invalid native operation");
  const input = Object.freeze(spec.params.parse(params));
  const done = Promise.withResolvers();
  let state = "pending";
  let started = false;
  let outcome;
  let observation;
  const write = (next, result) => {
    const audit = action === "command" && typeof result?.text === "string"
      ? { status: result.status, textLength: result.text.length, textHash: createHash("sha256").update(result.text).digest("hex") } : result;
    return record({ operationId: id, action, claudeSessionId, state: next,
      ...(action === "command" ? { command: input.command } : {}), ...(audit ? { result: audit } : {}) });
  };
  write("pending");
  const settle = (result) => {
    write(result.status, result);
    state = result.status;
    outcome = Object.freeze(result);
    done.resolve(outcome);
    return outcome;
  };
  return {
    id, action, params: input, claudeSessionId, result: done.promise,
    get claimed() { return started; },
    get observed() { return observation; },
    observe(payload) {
      if (!spec.receipt) throw new Error("this native operation takes no observation receipt");
      const receipt = compactResult.parse(payload);
      if (state !== "claimed") throw new Error("native operation has not been claimed");
      if (!["succeeded", "skipped"].includes(receipt.status)) throw new Error("invalid compact observation");
      if (observation !== undefined) {
        if (!isDeepStrictEqual(observation, receipt)) throw new Error("different compact observation");
        return observation;
      }
      write("observed", receipt);
      observation = Object.freeze(receipt);
      return observation;
    },
    claim() {
      if (state !== "pending") return { execute: false, state };
      write("claimed");
      started = true;
      state = "claimed";
      return { execute: true, action, params: input };
    },
    complete(payload) {
      const result = spec.result.parse(payload);
      if (outcome !== undefined) {
        if (!isDeepStrictEqual(outcome, result)) throw new Error("native operation settled with a different result");
        return outcome;
      }
      if (state !== "claimed") throw new Error("native operation has not been claimed");
      // compact 的完成必须有独立观察凭据；command 的文本本身就是产物。
      if (spec.receipt && ["succeeded", "skipped"].includes(result.status) && !isDeepStrictEqual(observation, result)) {
        throw new Error("native compact has no matching observation receipt");
      }
      return settle(result);
    },
    fail(reason) {
      if (outcome !== undefined) return outcome;
      return settle({ status: state === "claimed" ? "uncertain" : "failed", reason: String(reason).slice(0, 1024) || "native operation ended" });
    },
  };
}
