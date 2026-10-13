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
const hash = (value) => createHash("sha256").update(value).digest();

export async function createModHost({ session, agent, epoch, goalHandlers, onPrompt, signal, requestTimeoutMs = 5000 } = {}) {
  if (!session?.id || !agent?.id || typeof epoch !== "string" || epoch === "") throw new TypeError("mod host requires session, agent and epoch");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30000) throw new TypeError("invalid bridge timeout");
  signal?.throwIfAborted();
  const identity = { sessionId: session.id, agentId: agent.id, epoch };
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hash(token);
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
  const live = () => !closed && !signal?.aborted && session.id === identity.sessionId && agent.id === identity.agentId && agent.status === "running";
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    let bodyTimer;
    try {
      if (request.headers.origin !== undefined) { reply(response, 403, { error: "browser callers are not allowed" }); request.resume(); return; }
      const authorization = request.headers.authorization ?? "";
      const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (presented.length > 256 || !timingSafeEqual(tokenHash, hash(presented))) { reply(response, 401, { error: "unauthorized" }); request.resume(); return; }
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
      if (!live() || body.sessionId !== identity.sessionId || body.agentId !== identity.agentId || body.epoch !== epoch
        || body.callerAgentId !== null || (claudeSessionId !== undefined && body.claudeSessionId !== claudeSessionId)) {
        reply(response, 403, { error: "caller identity mismatch" }); return;
      }
      const digest = hash(JSON.stringify(body)).toString("hex");
      const prior = cache.get(body.requestId);
      if (prior) {
        if (prior.digest !== digest) { reply(response, 409, { error: "request id reused with different input" }); return; }
        const result = await prior.result;
        reply(response, result.status, result.body);
        return;
      }
      if (cache.size >= 4096) { reply(response, 429, { error: "run request budget exhausted" }); return; }
      if (body.method !== "handshake" && !GOAL_METHODS.has(body.method) && body.method !== "prompt_snapshot") { reply(response, 404, { error: "unknown method" }); return; }
      if (body.method !== "handshake" && claudeSessionId === undefined) { reply(response, 403, { error: "handshake required" }); return; }
      if (body.method === "prompt_snapshot" && typeof onPrompt !== "function") { reply(response, 404, { error: "prompt capture unavailable" }); return; }
      if (GOAL_METHODS.has(body.method) && typeof goalHandlers?.[body.method] !== "function") { reply(response, 404, { error: "goal adapter unavailable" }); return; }
      let params = body.params;
      try {
        if (body.method === "handshake") params = handshakeSchema.parse(params);
        if (body.method === "prompt_snapshot") {
          params = promptSchema.parse(params);
          params.sections = validatePromptSections(params.sections);
        }
      } catch { reply(response, 400, { error: "invalid method input" }); return; }
      const abort = new AbortController();
      operations.add(abort);
      let methodTimer;
      const result = Promise.race([
        Promise.resolve().then(async () => {
          if (!live() || abort.signal.aborted) return { status: 403, body: { error: "run is not live" } };
          if (body.method === "handshake") {
            claudeSessionId = body.claudeSessionId;
            if (params.ready === true) ready.resolve({ claudeSessionId });
            return { status: 200, body: { value: { protocol: 1, capture: typeof onPrompt === "function" ? "observed-compose" : false,
              tools: goalHandlers ? goalToolDefinitions().filter((tool) => typeof goalHandlers[tool.name] === "function") : [] } } };
          }
          const value = body.method === "prompt_snapshot"
            ? await onPrompt?.(params, { signal: abort.signal })
            : await goalHandlers[body.method](params);
          if (abort.signal.aborted || !live()) return { status: 408, body: { error: "request canceled" } };
          return { status: 200, body: { value } };
        }).catch(() => ({ status: 500, body: { error: "bridge method failed" } })),
        new Promise((resolve) => { methodTimer = setTimeout(() => {
          abort.abort(); resolve({ status: 408, body: { error: "bridge method timed out" } });
        }, requestTimeoutMs); }),
      ]).finally(() => { clearTimeout(methodTimer); operations.delete(abort); });
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
  return { url, token, ready: ready.promise, close };
}
