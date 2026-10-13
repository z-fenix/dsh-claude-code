// prompt.compose 的观察快照，不冒充最终提示词，也不修改模型 surface。
import { createHash } from "node:crypto";
import { pluginFacts } from "./plugin-facts.mjs";

export function validatePromptSections(value) {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError("prompt sections must be a bounded array");
  const ids = new Set();
  let sessionStarted = false;
  let bytes = 0;
  return value.map((section) => {
    if (!section || typeof section !== "object" || Array.isArray(section)
      || Object.keys(section).some((key) => !["id", "text", "scope"].includes(key))) throw new TypeError("invalid prompt section");
    if (typeof section.id !== "string" || section.id.trim() === "" || section.id.length > 128 || ids.has(section.id)) throw new TypeError("prompt section ids must be non-empty and unique");
    if (typeof section.text !== "string" || !["shared", "session"].includes(section.scope)) throw new TypeError("invalid prompt section text/scope");
    if (sessionStarted && section.scope === "shared") throw new TypeError("shared prompt sections must precede session sections");
    if (section.scope === "session") sessionStarted = true;
    ids.add(section.id);
    const length = Buffer.byteLength(section.text, "utf8");
    bytes += length;
    if (length > 128 * 1024 || bytes > 384 * 1024) throw new TypeError("prompt snapshot exceeds byte budget");
    return { id: section.id, text: section.text, scope: section.scope };
  });
}

export class PromptSnapshotRecorder {
  #session;
  #agent;
  #epoch;
  #last;
  constructor({ session, agent, epoch }) {
    this.#session = session;
    this.#agent = agent;
    this.#epoch = epoch;
    this.#last = pluginFacts(session).events().findLast((event) => event.type === "claude-code/prompt-snapshot");
  }
  record({ sections: value, model }) {
    const sections = validatePromptSections(value);
    if (model !== undefined && (typeof model !== "string" || model.length > 256)) throw new TypeError("invalid snapshot model");
    const digest = createHash("sha256").update(JSON.stringify({ sections, model })).digest("hex");
    if (this.#last?.data.digest === digest) return { digest, factSeq: this.#last.factSeq, legacySeq: this.#last.seq, unchanged: true, source: "observed-compose" };
    this.#last = pluginFacts(this.#session).append("claude-code/prompt-snapshot", {
      provider: "claude-code", sessionId: this.#session.id, agentId: this.#agent.id, epoch: this.#epoch,
      source: "observed-compose", completeness: "partial", compositionLoop: "unattributed", sections, digest,
      ...(model === undefined ? {} : { model }),
    });
    return { digest, factSeq: this.#last.factSeq, legacySeq: this.#last.seq, unchanged: false, source: "observed-compose" };
  }
}
