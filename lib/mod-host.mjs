// 只向一个活运行提供白名单 RPC；令牌不进入会话日志，不暴露任意宿主调用。
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { goalToolDefinitions } from "./goal-domain.mjs";
import { validatePromptSections } from "./prompt-snapshot.mjs";

const MAX_BYTES = 512 * 1024;
const GOAL_METHODS = new Set(["get_goal", "create_goal", "update_goal"]);
const envelopeSchema = z.strictObject({
  sessionId: z.string().min(1).max(128), agentId: z.string().min(1).max(128), epoch: z.string().min(1).max(128),
  claudeSessionId: z.string().min(1).max(128), callerAgentId: z.string().max(128).nullable(),
  requestId: z.string().min(1).max(128), method: z.string().min(1).max(64), params: z.record(z.string(), z.unknown()),
});
const promptSchema = z.strictObject({ sections: z.unknown(), model: z.string().max(256).optional() });
const handshakeSchema = z.strictObject({ protocol: z.literal(1), ready: z.boolean().optional() });
const claimSchema = z.strictObject({ operationId: z.string().min(1).max(128) });
const completeSchema = claimSchema.extend({ result: z.unknown() });
const MAINTENANCE_METHODS = new Set(["handshake", "maintenance_claim", "maintenance_complete", "maintenance_observe", "maintenance_result"]);
const hash = (value) => createHash("sha256").update(value).digest();

export async function createModHost({ session, agent, epoch, goalHandlers, onPrompt, maintenance, runtime, signal, requestTimeoutMs = 5000 } = {}) {
  if (!session?.id || !agent?.id || typeof epoch !== "string" || epoch === "") throw new TypeError("mod host requires session, agent and epoch");
  if (maintenance && (typeof maintenance.isLive !== "function" || !maintenance.operation?.claudeSessionId
    || typeof maintenance.operation.claim !== "function" || typeof maintenance.operation.complete !== "function")) {
    throw new TypeError("maintenance bridge requires an operation and live lease");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30000) throw new TypeError("invalid bridge timeout");
  signal?.throwIfAborted();
  const identity = { sessionId: session.id, agentId: agent.id, epoch };
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hash(token);
  const observerToken = maintenance ? randomBytes(32).toString("base64url") : undefined;
  const observerHash = observerToken === undefined ? undefined : hash(observerToken);
  const cache = new Map();
  const operations = new Set();
  const ready = Promise.withResolvers();
  let closed = false;
  let closePromise;
  let claudeSessionId;
  let url;

  const reply = (response, status, value) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const live = () => !closed && !signal?.aborted && session.id === identity.sessionId && agent.id === identity.agentId
    && (maintenance ? maintenance.isLive() === true : agent.status === "running");
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    let bodyTimer;
    try {
      if (request.headers.origin !== undefined) { reply(response, 403, { error: "browser callers are not allowed" }); request.resume(); return; }
      const authorization = request.headers.authorization ?? "";
      const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const presentedHash = hash(presented);
      const observer = observerHash !== undefined && timingSafeEqual(observerHash, presentedHash);
      if (presented.length > 256 || (!observer && !timingSafeEqual(tokenHash, presentedHash))) { reply(response, 401, { error: "unauthorized" }); request.resume(); return; }
      if (request.method !== "POST" || request.url !== "/bridge" || request.headers.host !== new URL(url).host) { reply(response, 404, { error: "not found" }); request.resume(); return; }
      if (!live()) { reply(response, 403, { error: "run is not live" }); request.resume(); return; }
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") { reply(response, 400, { error: "JSON required" }); request.resume(); return; }
      let bytes = 0;
      const chunks = [];
      bodyTimer = setTimeout(() => { reply(response, 408, { error: "request body timed out" }); request.destroy(); }, requestTimeoutMs);
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { reply(response, 413, { error: "request exceeds byte budget" }); request.resume(); return; }
        chunks.push(chunk);
      }
      clearTimeout(bodyTimer);
      let body;
      try { body = envelopeSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reply(response, 400, { error: "invalid request" }); return; }
      const runtimeMethod = !maintenance && runtime?.has(body.method) === true;
      if (!live() || body.sessionId !== identity.sessionId || body.agentId !== identity.agentId || body.epoch !== epoch
        || (body.callerAgentId !== null && !(runtimeMethod && runtime.allowsChild(body.method) === true)) || (claudeSessionId !== undefined && body.claudeSessionId !== claudeSessionId)
        || (maintenance && body.claudeSessionId !== maintenance.operation.claudeSessionId)) {
        reply(response, 403, { error: "caller identity mismatch" }); return;
      }
      if (maintenance && (observer !== (body.method === "maintenance_observe"))) {
        reply(response, 403, { error: "bridge role mismatch" }); return;
      }
      const digest = hash(JSON.stringify(body)).toString("hex");
      const prior = cache.get(body.requestId);
      if (prior) {
        if (prior.digest !== digest) { reply(response, 409, { error: "request id reused with different input" }); return; }
        // 执行许可不同于结果：丢失一次应答必须 uncertain，不能把缓存的 true 再交给新 worker。
        if (body.method === "maintenance_claim") { reply(response, 200, { value: { execute: false, state: "already-delivered" } }); return; }
        const result = await prior.result;
        reply(response, result.status, result.body);
        return;
      }
      if (cache.size >= 4096) { reply(response, 429, { error: "run request budget exhausted" }); return; }
      const allowed = maintenance ? MAINTENANCE_METHODS.has(body.method)
        : body.method === "handshake" || GOAL_METHODS.has(body.method) || body.method === "prompt_snapshot" || runtimeMethod;
      if (!allowed) { reply(response, 404, { error: "unknown method" }); return; }
      if (body.method !== "handshake" && claudeSessionId === undefined) { reply(response, 403, { error: "handshake required" }); return; }
      if (body.method === "prompt_snapshot" && typeof onPrompt !== "function") { reply(response, 404, { error: "prompt capture unavailable" }); return; }
      if (GOAL_METHODS.has(body.method) && typeof goalHandlers?.[body.method] !== "function") { reply(response, 404, { error: "goal adapter unavailable" }); return; }
      let params = body.params;
      try {
        if (body.method === "handshake") params = handshakeSchema.parse(params);
        if (runtimeMethod) params = runtime.parse(body.method, params);
        if (body.method === "maintenance_claim" || body.method === "maintenance_result") params = claimSchema.parse(params);
        if (body.method === "maintenance_complete" || body.method === "maintenance_observe") params = completeSchema.parse(params);
        if (body.method === "prompt_snapshot") {
          params = promptSchema.parse(params);
          params.sections = validatePromptSections(params.sections);
        }
      } catch { reply(response, 400, { error: "invalid method input" }); return; }
      if (maintenance && body.method !== "handshake" && params.operationId !== maintenance.operation.id) {
        reply(response, 403, { error: "operation identity mismatch" }); return;
      }
      const methodTimeout = runtimeMethod ? runtime.timeoutMs?.(body.method, params) ?? requestTimeoutMs : requestTimeoutMs;
      if (!Number.isSafeInteger(methodTimeout) || methodTimeout < 1 || methodTimeout > 300000) { reply(response, 400, { error: "invalid method timeout" }); return; }
      const abort = new AbortController();
      operations.add(abort);
      const responseClosed = () => { if (!response.writableEnded) abort.abort(); };
      response.once("close", responseClosed);
      let methodTimer;
      let abortWait;
      const result = Promise.race([
        Promise.resolve().then(async () => {
          if (!live() || abort.signal.aborted) return { status: 403, body: { error: "run is not live" } };
          if (body.method === "handshake") {
            claudeSessionId = body.claudeSessionId;
            if (params.ready === true) ready.resolve({ claudeSessionId });
            return { status: 200, body: { value: { protocol: 1, capture: !maintenance && typeof onPrompt === "function" ? "observed-compose" : false,
              tools: !maintenance && goalHandlers ? goalToolDefinitions().filter((tool) => typeof goalHandlers[tool.name] === "function") : [],
              ...(!maintenance && runtime ? { runtime: runtime.capabilities } : {}),
              ...(!maintenance && typeof runtime?.dshDefinitions === "function" ? { dshTools: runtime.dshDefinitions() } : {}),
              ...(maintenance ? { maintenance: { operationId: maintenance.operation.id, action: maintenance.operation.action, params: maintenance.operation.params } } : {}),
            } } };
          }
          const value = runtimeMethod ? await runtime.invoke(body.method, params, { callerAgentId: body.callerAgentId, signal: abort.signal })
            : body.method === "maintenance_claim" ? maintenance.operation.claim()
            : body.method === "maintenance_observe" ? maintenance.operation.observe(params.result)
            : body.method === "maintenance_result" ? maintenance.operation.observed ?? null
            : body.method === "maintenance_complete" ? maintenance.operation.complete(params.result)
            : body.method === "prompt_snapshot" ? await onPrompt?.(params, { signal: abort.signal })
            : await goalHandlers[body.method](params);
          if (abort.signal.aborted || !live()) return { status: 408, body: { error: "request canceled" } };
          return { status: 200, body: { value } };
        }).catch(() => ({ status: 500, body: { error: "bridge method failed" } })),
        new Promise((resolve) => {
          abortWait = () => resolve({ status: 408, body: { error: "bridge method canceled" } });
          abort.signal.addEventListener("abort", abortWait, { once: true });
        }),
        new Promise((resolve) => { methodTimer = setTimeout(() => {
          abort.abort(); resolve({ status: 408, body: { error: "bridge method timed out" } });
        }, methodTimeout); }),
      ]).finally(() => {
        clearTimeout(methodTimer); operations.delete(abort);
        if (abortWait) abort.signal.removeEventListener("abort", abortWait);
        response.removeListener("close", responseClosed);
      });
      cache.set(body.requestId, { digest, result });
      const settled = await result;
      reply(response, settled.status, settled.body);
    } catch {
      reply(response, 400, { error: "invalid request" });
    } finally { clearTimeout(bodyTimer); }
  });
  server.maxHeadersCount = 32;
  server.maxConnections = 16;
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs;
  server.maxRequestsPerSocket = 64;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${server.address().port}/bridge`;
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    signal?.removeEventListener("abort", onAbort);
    for (const operation of operations) operation.abort();
    closePromise = new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    return closePromise;
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) { await close(); signal.throwIfAborted(); }
  return { url, token, ...(observerToken === undefined ? {} : { observerToken }), ready: ready.promise, close };
}
