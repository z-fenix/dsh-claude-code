// 零用户输入的专用维护查询；不复用普通 turn/tracer，不借宿主 compaction 假压缩。
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { RunInputChannel } from "./run-input.mjs";
import { pluginFacts } from "./plugin-facts.mjs";
import { createNativeOperation } from "./native-operation.mjs";
import { createModHost } from "./mod-host.mjs";
import { buildModOptions, probeModSupport, MOD_PATH, COMPACT_OBSERVER_PATH } from "./mod-options.mjs";
import { compactObservation } from "./compact-observation.mjs";
import { foldModelSelection, readSessionEvents } from "./session-events.mjs";

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
export class NativeMaintenanceError extends Error {
  constructor(code, uncertain = false) {
    super(`dsh-claude-code: native maintenance ${code}${uncertain ? "; the CLI may already have changed its history; do not retry automatically" : ""}`);
    this.code = code;
    this.uncertain = uncertain;
  }
}

export async function runNativeMaintenance({ agent, session, config = {}, executable, env = {}, claudeSessionId,
  signal, commandId, action = "compact", params = {}, isLive }) {
  if (config.mods?.enabled !== true) throw new NativeMaintenanceError("unsupported");
  if (config.persistSession === false || typeof claudeSessionId !== "string" || !claudeSessionId) throw new NativeMaintenanceError("history");
  if (typeof isLive !== "function" || isLive() !== true) throw new NativeMaintenanceError("busy");
  const timeout = config.mods?.maintenanceTimeoutMs ?? 300000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) throw new TypeError("invalid maintenance timeout");
  const controller = new AbortController();
  const channel = new RunInputChannel();
  const aborted = Promise.withResolvers();
  let timedOut = false;
  let host;
  let operation;
  let liveQuery;
  let reader;
  const forwardAbort = () => controller.abort(signal?.reason);
  const stop = () => { channel.close(); liveQuery?.close(); aborted.resolve(); };
  signal?.addEventListener("abort", forwardAbort, { once: true });
  controller.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  if (signal?.aborted) forwardAbort();
  try {
    if (controller.signal.aborted) throw new NativeMaintenanceError("cancelled");
    const supports = await Promise.all([MOD_PATH, COMPACT_OBSERVER_PATH].map((modPath) =>
      probeModSupport({ executable, env, signal: controller.signal, modPath })));
    if (supports.some((support) => !support.supported)) throw new NativeMaintenanceError("unsupported");
    if (controller.signal.aborted || !isLive()) throw new NativeMaintenanceError("cancelled");
    const epoch = randomUUID();
    const facts = pluginFacts(session);
    operation = createNativeOperation({ id: randomUUID(), action, params, claudeSessionId,
      record: (data) => facts.append("claude-code/native-operation", { ...data, epoch,
        ...(typeof commandId === "string" ? { commandId } : {}) }) });
    host = await createModHost({ session, agent, epoch, signal: controller.signal,
      maintenance: { operation, isLive } });
    const descriptor = { url: host.url, token: host.token, sessionId: session.id, agentId: agent.id, epoch };
    const isolatedEnv = { ...env };
    delete isolatedEnv.CLAUDE_CODE_PLUGIN_DIRS;
    delete isolatedEnv.DSH_CLAUDE_COMPACT_OBSERVER;
    const selected = buildModOptions({ config: { ...config, plugins: [] }, env: isolatedEnv, supported: true, bridge: descriptor });
    const selection = foldModelSelection(readSessionEvents(session));
    const model = selection?.model ?? agent.options?.model;
    const options = { ...selected.sdkOptions,
      plugins: [...selected.sdkOptions.plugins, { type: "local", path: COMPACT_OBSERVER_PATH }],
      env: { ...selected.sdkOptions.env, DSH_CLAUDE_COMPACT_OBSERVER: JSON.stringify({ ...descriptor,
        token: host.observerToken, operationId: operation.id }) },
      cwd: session.header.cwd, pathToClaudeCodeExecutable: executable, resume: claudeSessionId,
      persistSession: true, abortController: controller, settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [],
      canUseTool: async () => ({ behavior: "deny", message: "maintenance queries do not execute model tools" }),
      ...(typeof model === "string" && model ? { model } : {}),
      ...(EFFORTS.has(selection?.reasoningEffort) ? { effort: selection.reasoningEffort } : {}),
    };
    liveQuery = query({ prompt: channel, options });
    if (controller.signal.aborted) stop();
    reader = (async () => {
      for await (const message of liveQuery) {
        if (message.type === "system" && message.subtype === "init" && message.session_id !== claudeSessionId) {
          throw new NativeMaintenanceError("history");
        }
        const observation = compactObservation(message);
        if (observation) facts.append("claude-code/compact", { ...observation, operationId: operation.id, epoch });
      }
    })();
    const result = await Promise.race([
      operation.result,
      reader.then(() => { throw new NativeMaintenanceError("failed"); }),
      aborted.promise.then(() => { throw new NativeMaintenanceError(timedOut ? "timeout" : "cancelled"); }),
    ]);
    channel.end();
    await reader;
    if (controller.signal.aborted) throw new NativeMaintenanceError(timedOut ? "timeout" : "cancelled");
    if (!["succeeded", "skipped"].includes(result.status)) throw new NativeMaintenanceError(result.status);
    return result;
  } catch (error) {
    const uncertain = operation?.claimed === true;
    const code = timedOut ? "timeout" : controller.signal.aborted ? "cancelled"
      : error instanceof NativeMaintenanceError ? error.code : "failed";
    try { operation?.fail(code); } catch {}
    throw new NativeMaintenanceError(code, uncertain);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", stop);
    channel.close();
    liveQuery?.close();
    await reader?.catch(() => {});
    await host?.close();
  }
}
