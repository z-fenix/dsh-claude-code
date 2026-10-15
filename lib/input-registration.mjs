// 原生登记与 submitted/observed 独立；只有完整历史证据可以复用登记。
import { isDeepStrictEqual } from "node:util";
import { pluginFacts } from "./plugin-facts.mjs";

export function inspectInputRegistration(session, message) {
  if (typeof message.id !== "string" || message.id.trim() === "") {
    throw new Error("input-registration: message id is required");
  }
  const history = pluginFacts(session).events();
  const candidates = history.filter((event) => event.type === "user/message"
    && event.data?.id === message.id);
  if (candidates.length === 0) return { kind: "unregistered" };
  if (candidates.length !== 1) throw new Error("input-registration: duplicate native candidates");
  const event = candidates[0];
  const reservations = history.filter((record) => record.type === "claude-code/input"
    && record.data?.state === "reserved" && record.data.messageId === message.id);
  const conflicting = reservations.some((record) => !isDeepStrictEqual(record.data.message, message));
  const proven = reservations.some((record) => Number.isSafeInteger(record.afterSeq)
    && record.afterSeq < event.seq && isDeepStrictEqual(record.data.message, message));
  if (conflicting || !proven || !isDeepStrictEqual(event.data, message)) {
    throw new Error("input-registration: conflicting or unproven native event");
  }
  return { kind: "registered", event };
}

export function registerInputMessage(session, message) {
  const found = inspectInputRegistration(session, message);
  return found.kind === "registered" ? found.event
    : session.append("user/message", message, { surfaceOp: "append" });
}
