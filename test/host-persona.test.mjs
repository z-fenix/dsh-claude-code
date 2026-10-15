// test/host-persona.test.mjs — 宿主装配的 persona 段落要按项显式桥接给 Claude。
//
// 背景（工具桥验收 §六 的已知缺口）：本插件刻意不派发 `agent/pre-step`，所以
// `systemPrompt.assemble()` 的产物从来不进 Claude 的请求。宿主为此装配的有三类东西，
// 只有 persona 这一段适合逐项转发：
//   - persona（`deployment:persona-prefix/suffix`）是**部署方在预设里写死的身份文本**，
//     例如「You are Claude Code, an agent working inside DeepSeek Harness.」，
//     丢掉它等于用户配的 persona 在 Claude 会话里静默失效；
//   - 各工具段落（`tool:bash` 等）描述的是 **DSH 的工具**，Claude 用的是自己那套，
//     转发过去就是在给模型广告它没有的能力；
//   - runtime contexts 描述的是 DSH 的沙箱/审批语义，而 Claude 模式下真正生效的是
//     本插件的 permission/approval 策略，转过去等于虚构安全边界。
// 所以这里锁定：**按名字白名单只取 persona 两段**，插值后转发，其余一律不碰。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_CLAUDE_CODE_STORE = mkdtempSync(join(tmpdir(), "dsh-cc-persona-"));

let capturedOptions = [];
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: ({ options }) => { capturedOptions.push(options); return (async function* empty() {})(); },
    createSdkMcpServer: (opts) => opts,
    tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
  },
});
const { readHostPersona, PERSONA_SECTION_NAMES } = await import("../lib/host-persona.mjs");
const { runClaudeCode } = await import("../lib/claude-run.mjs");
const { pluginFacts } = await import("../lib/plugin-facts.mjs");

/** 假 systemPrompt 服务：复刻宿主 assemble() 的返回形状。 */
function promptService(sections, variables = {}) {
  const calls = [];
  return {
    calls,
    assemble: async (context) => {
      calls.push(context);
      return { sections, contexts: [], tools: [], variables };
    },
  };
}
const ctxWith = (systemPrompt) => ({
  get: (name) => (name === "systemPrompt" ? systemPrompt : undefined),
  logger: { warn() {}, info() {} },
});

const personaSections = [
  { name: "harness:identity", order: -1000, text: "You are an AI agent powered by DeepSeek Harness." },
  { name: "deployment:persona-prefix", order: 0, text: "You are Claude Code, working in {{cwd}}." },
  { name: "tool:bash", order: 1000, text: "Use the bash tool to run shell commands." },
  { name: "deployment:persona-suffix", order: 10200, text: "Your working directory is {{cwd}}." },
];

test("只取 persona 两段，并按宿主的变量插值", async () => {
  const service = promptService(personaSections, { cwd: "C:\\work" });
  const result = await readHostPersona({ ctx: ctxWith(service), agent: { id: "a1" }, signal: undefined });

  assert.equal(result.text, "You are Claude Code, working in C:\\work.\n\nYour working directory is C:\\work.");
  assert.equal(result.reason, undefined);
  assert.match(result.text, /^You are Claude Code/);
  assert.doesNotMatch(result.text, /DeepSeek Harness/, "harness 身份段不是 persona，不得混入");
  assert.doesNotMatch(result.text, /bash tool/, "工具用法段落描述的是 DSH 工具，转发即在广告不存在的能力");
});

test("装配用的 context 必须带上 agent 自身作 scope（否则取不到 agent scope 的段落）", async () => {
  const agent = { id: "a1" };
  const service = promptService(personaSections, { cwd: "/w" });
  await readHostPersona({ ctx: ctxWith(service), agent, signal: undefined });
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].agent, agent);
  assert.equal(service.calls[0].scope, agent);
});

test("persona 标了 complete 时不转发：append 表达不了「整段替换」", async () => {
  const service = promptService(
    [{ name: "deployment:persona-prefix", order: 0, text: "ONLY THIS", complete: true }],
    {},
  );
  const result = await readHostPersona({ ctx: ctxWith(service), agent: { id: "a1" } });
  assert.equal(result.text, "");
  assert.match(result.reason, /complete/i);
});

test("没有 systemPrompt 服务 / 装配抛错 → 静默缺席，不抛错也不发空文本", async () => {
  const absent = await readHostPersona({ ctx: { get: () => undefined, logger: { warn() {} } }, agent: { id: "a1" } });
  assert.equal(absent.text, "");
  assert.match(absent.reason, /service/);

  const broken = await readHostPersona({
    ctx: ctxWith({ assemble: async () => { throw new Error("boom"); } }),
    agent: { id: "a1" },
  });
  assert.equal(broken.text, "");
  assert.match(broken.reason, /boom/);
});

test("变量解析不出来时丢掉那一段，绝不把 {{name}} 原样发给模型", async () => {
  const service = promptService([
    { name: "deployment:persona-prefix", order: 0, text: "cwd={{cwd}}" },
    { name: "deployment:persona-suffix", order: 1, text: "static suffix" },
  ], {});
  const result = await readHostPersona({ ctx: ctxWith(service), agent: { id: "a1" } });
  assert.equal(result.text, "static suffix");
  assert.match(result.reason, /cwd/);
});

test("白名单就是宿主导出的两个段落名，顺序固定为 prefix → suffix", () => {
  assert.deepEqual(PERSONA_SECTION_NAMES, ["deployment:persona-prefix", "deployment:persona-suffix"]);
});

test("如实报告宿主装配到的 persona 段数（『一段都没有』与『有段但文本为空』不是一回事）", async () => {
  const none = await readHostPersona({
    ctx: ctxWith(promptService([{ name: "tool:bash", order: 1, text: "x" }], {})),
    agent: { id: "a1" },
  });
  assert.equal(none.sections, 0);
  assert.match(none.reason, /no persona section/);

  const broken = await readHostPersona({ ctx: { get: () => undefined }, agent: { id: "a1" } });
  assert.equal(broken.sections, 0);

  // 真宿主在**全局**无条件注册这两段（文本为空）。scope 没挂 persona 时就是这个形状：
  // 段数是 2、文本是空串、**没有 reason** —— 只靠 text/reason 分不出「宿主没配 persona」
  // 和「配了但没转到」。2026-10-15 的隔离复验正是踩在这里：模型侧查无 persona 文本，
  // 插件侧却一片安静。段数就是那个缺失的观测点。
  const empty = await readHostPersona({
    ctx: ctxWith(promptService([
      { name: "deployment:persona-prefix", order: 0, text: "" },
      { name: "deployment:persona-suffix", order: 1, text: "" },
    ], {})),
    agent: { id: "a1" },
  });
  assert.equal(empty.text, "");
  assert.equal(empty.reason, undefined);
  assert.equal(empty.sections, 2, "两段空 persona 也算装配到了段，必须与「0 段」区分开");

  const real = await readHostPersona({ ctx: ctxWith(promptService(personaSections, { cwd: "C:\\w" })), agent: { id: "a1" } });
  assert.equal(real.sections, 2);
});

// ── 接线：persona 必须真的进 SDK options ──────────────────────────────────────

const ev = (type, data) => ({ type, data, seq: 0 });
let sessionSeq = 0;
const session = () => {
  const id = `p${++sessionSeq}`;
  return {
    id, append() {}, requestContext: () => undefined, requestHeader: () => undefined,
    snapshotEvents: () => [ev("sandbox/mode", { mode: "workspace-write" })],
  };
};
const base = (ctx) => ({
  ctx, config: {}, session: session(), agent: { id: "a1", status: "running" },
  turn: 1, prompt: "hi", signal: new AbortController().signal, cwd: "C:\\w", executable: "claude", env: {},
  turnContext: () => ({ hasHumanMessage: true }),
});

test("宿主 persona 进入 systemPrompt.append（preset 仍是 claude_code）", async () => {
  capturedOptions = [];
  const service = promptService(personaSections, { cwd: "C:\\w" });
  await runClaudeCode(base(ctxWith(service)));
  const options = capturedOptions[0];
  assert.equal(options.systemPrompt.type, "preset");
  assert.equal(options.systemPrompt.preset, "claude_code");
  assert.match(options.systemPrompt.append, /You are Claude Code, working in C:\\w\./);
});

test("没有 persona 也没有 goal 时不留空的 systemPrompt", async () => {
  capturedOptions = [];
  await runClaudeCode(base({ get: () => undefined, logger: { warn() {}, info() {} } }));
  assert.equal(capturedOptions[0].systemPrompt, undefined);
});

test("persona 与 goal 指引并存时互不覆盖", async () => {
  capturedOptions = [];
  const service = promptService(personaSections, { cwd: "C:\\w" });
  const ctx = {
    get: (name) => (name === "systemPrompt" ? service : name === "goals" ? { get: () => undefined } : undefined),
    logger: { warn() {}, info() {} },
  };
  await runClaudeCode(base(ctx));
  const append = capturedOptions[0].systemPrompt.append;
  assert.match(append, /You are Claude Code, working in C:\\w\./);
  assert.match(append, /consecutive goal rounds/);
});

// ── 宿主契约：agent 作用域必须能**按属性**读到 tools ─────────────────────────────

// 2026-10-15 隔离实例实测：宿主 `@deepseek-ai/dsh-file-reference-local` 在 agent scope 里
// 注册了一段 `context:file-reference`，它的 text 回调是 `agent.ctx.tools.get("read", agent)`。
// `SystemPrompt.assemble()` 逐个求值所有段落的 text 且**不做逐段隔离**，于是这一段抛错会让
// **整次装配**失败——插件的 persona 读取跟着一起死，表面只剩一句 reason。
// 同一轮里实测到的形状：
//   ctx.get("tools")       → object（服务可达）
//   ctx.tools              → throw cannot get property "tools" without inject
//   agent.ctx.get("tools") → object
//   agent.ctx.tools        → 同上抛错
// 属性访问能不能过由 fiber 的 inject 声明决定：插件只 inject 了
// agents/sessions/sessionPersistence，它造出来的 agent scope 于是也读不到 `tools`。
// 这条断言钉住那个声明——它一旦被删，persona 会在真实实例里静默失效。
test("插件必须 inject tools：宿主按属性读 agent.ctx.tools 的段落会整趟拖垮装配", async () => {
  const { inject } = await import("../index.mjs");
  assert.ok(inject.includes("tools"), "宿主 agent-scope 的 prompt 段落按属性读 agent.ctx.tools；不 inject 就会让整次 assemble 抛错，persona 静默不转发");
});

test("persona 结果落成私有事实：静默不转发也能被查到", async () => {
  capturedOptions = [];
  const runSession = session();
  // 宿主全局无条件注册的空 persona：有段、无文本、无 reason —— 线上那个静默形状。
  const service = promptService([
    { name: "deployment:persona-prefix", order: 0, text: "" },
    { name: "deployment:persona-suffix", order: 1, text: "" },
  ], {});
  await runClaudeCode({ ...base(ctxWith(service)), session: runSession });

  const fact = pluginFacts(runSession).events().find((event) => event.type === "claude-code/host-persona");
  assert.ok(fact, "persona 结果必须落成事实，否则静默失效无从查证");
  assert.equal(fact.data.forwarded, false);
  assert.equal(fact.data.sections, 2);
  assert.equal(fact.data.chars, 0);
  assert.equal(fact.data.reason, undefined, "有段无文本在宿主里是合法形状，不该编造 reason");
  assert.equal(capturedOptions[0].systemPrompt, undefined, "没转发就不该留空的 systemPrompt");
});

test("persona 真的转发时事实也如实标注", async () => {
  capturedOptions = [];
  const runSession = session();
  await runClaudeCode({ ...base(ctxWith(promptService(personaSections, { cwd: "C:\\w" }))), session: runSession });

  const fact = pluginFacts(runSession).events().find((event) => event.type === "claude-code/host-persona");
  assert.equal(fact.data.forwarded, true);
  assert.equal(fact.data.sections, 2);
  assert.ok(fact.data.chars > 0);
  assert.equal(fact.data.reason, undefined);
  assert.equal(Object.hasOwn(fact.data, "text"), false, "事实里不落 persona 正文，只落长度与段数");
});
