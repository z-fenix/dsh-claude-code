# Claude Code 会话的 goal 模式 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让由 Claude Code CLI 驱动的 DSH 会话支持标准模式那套持久化 goal：`/goal <目标>` 后自动多轮推进，直到 Claude 把目标标记 complete/blocked 或轮数上限耗尽。

**Architecture:** 复用 host 平面已有的 goal 栈（`ctx.goals` 服务 + `dsh-goal-round-driver` + `/goal` 命令 + GoalBar）。插件只新增两件事：把模型侧 goal 工具（`get_goal`/`create_goal`/`update_goal`）以**进程内 MCP server**（SDK `createSdkMcpServer`）桥接给 Claude Code；给 Claude 追加一段 goal 策略提示。goal 的持久化、轮数上限、阻塞阈值、不变量全部由 host goal 栈负责，插件不复制。

**Tech Stack:** Node.js ESM、`@anthropic-ai/claude-agent-sdk`（`query` / `createSdkMcpServer` / `tool`）、`zod` v4、`node:test` + `node:assert/strict`。

**Spec:** `docs/superpowers/specs/2026-10-12-claude-code-goal-mode-design.md`

## Global Constraints

- 插件永不自行 `session.append("goal/change")`，永不手搓 `source.kind === "goal"` 的 `user/message`；所有 goal 变更经 `ctx.goals.*`，goal round 提示原样转发。（否则触发 `dsh-goal` / `dsh-goal-round-driver` 的全局严格不变量 → 会话判定 corrupt。）
- 桥接工具的任何异常都不得穿过 MCP 边界：一律返回 `{ content: [...], isError: true }`。
- 无 `ctx.get("goals")`（部署未装 goal 栈）或 `config.goal.enabled === false` 时，功能静默缺席，不报错。
- 不改变任何非 Claude Code 会话的行为。
- `canUseTool` 内 goal 工具的放行判定必须排在权限策略短路**之前**（否则 `no-prompt` 下被拒）。
- 工具名形如 `mcp__goal__<tool>`；server 名固定 `goal`。
- 桥接工具的调用者归属由**构造时绑定的 agent** 决定，不用 `ctx.agents.currentInitiator()`（ALS 上下文未必传播进 SDK 的 MCP 派发），与既有 `canUseTool`/AskUserQuestion 桥的显式传参风格一致。
- Node 版本与测试命令沿用：`pnpm test`（`node --test --experimental-test-module-mocks "test/**/*.test.mjs"`）。

## Review Focus

- **无 goal 服务 / 服务在会话中途不可用**：`ctx.get("goals")` 为 undefined → 不挂 bridge、不加提示，行为与改动前一致。→ Task 3 的「无 goals 服务时 buildGoalServer 返回 undefined」测试覆盖。
- **goal 服务抛领域错误（revision 过期 / 状态不允许）**：`update_goal` 必须返回 `isError` 可读文案，不打断回合、不污染日志。→ Task 5/6 的错误路径测试覆盖。
- **`create_goal` 在 goal round（无人类消息）被打**：必须拒绝。→ Task 4 覆盖。
- **`blocked` 早于阈值 / 缺 `blocked_reason`**：必须拒绝并给出明确文案。→ Task 6 覆盖。
- **非 Claude Code 会话**：`routeMainLoop` 委托原工厂，本改动零影响。→ 由既有 router 测试 + 不改动该路径保证，Task 9 的「关闭时 options 不含 mcpServers/systemPrompt」再兜一层。

---

### Task 1: 验证前提 —— host goal driver 是否真的续跑本插件的 agent

**Files:** 无代码改动（观测 + 决策门）。

**Interfaces:**
- Consumes: 现有插件（已 link 安装）。
- Produces: 结论「前提成立 / 不成立」。不成立则**停止**并回到 spec 重新设计。

> 这是整个设计的地基：host 的 `dsh-goal-round-driver` 是否能看见本插件 agent 的 `agent/status` / inbox 事件。已从源码分析认为能（本插件走 `agents.enter()` + `agentEvents(loopCtx, …)`），但必须实测。

- [ ] **Step 1: 确认插件已链接进 desktop profile 并重启应用**

```bash
# 若尚未安装（幂等）：
dsh plugin --profile desktop add "C:/Users/Administrator/workplace/project/tools/dsh-claude-code"
# 然后重启桌面应用
```

- [ ] **Step 2: 打开一个「Claude Code」预设的会话，执行 `/goal 验证 goal 续跑：在会话里创建文件 goal-check.txt`**

观察输入框上方的 GoalBar 是否出现目标，状态 active。

- [ ] **Step 3: 读取该会话日志，确认出现了 `<goal_round>` 用户消息与被转发的 Claude 回合**

```bash
# 会话日志位置（zstd，v4 jsonl）：
ls "C:/Users/Administrator/.dsh/sessions/"
# 用仓库自带 helper 解帧查看（确认 dump-session.mjs 存在；不存在则用 asar 的校验器路径）
node .dsh-diag/dump-session.mjs "<path-to-session.v4.jsonl.zstd>" | grep -n "goal_round" | head
```

Expected: 日志中出现 `user/message`，其 `content[].text` 含 `<goal_round>`，`source.kind === "goal"`，`round === 1`；其后有新的 Claude 助手步骤。

- [ ] **Step 4: 决策门**

- 若出现 `<goal_round>` 且 Claude 被再次驱动 → 前提成立，继续 Task 2。
- 若**没有**续跑 → 停止实现，记录：driver 未驱动本插件的 agent（把 `router-diag.log`、`%APPDATA%\@deepseek-ai\dsh-desktop\logs\` 与 session dump 附上），回到 spec §8 重新评估（可能需要补 `agent/pre-step`/`agent/created` 契约）。
- 若无法启动 GUI：改在 `.dsh-diag` 隔离 harness 复现（参考 `iso-*.log`、`verify-live-e2e.mjs` 的既有用法）。

- [ ] **Step 5: 清理**：`/goal clear`，删除 `goal-check.txt`（若已创建）。

*（本任务无 commit。）*

---

### Task 2: `lib/goal-bridge.mjs` — 纯函数（值投影 / 配置 / 策略文本）

**Files:**
- Create: `lib/goal-bridge.mjs`
- Test: `test/goal-bridge.test.mjs`

**Interfaces:**
- Produces:
  - `GOAL_SERVER_NAME = "goal"`；`GOAL_TOOL_PREFIX = "mcp__goal__"`
  - `resolveGoalConfig(config?) → { blockedAfterConsecutiveRounds:number, defaultMaxGoalRounds?:number }`（非法值抛 `TypeError`）
  - `goalValue(goal?) → { goal: null } | { goal:{id,revision,objective,phase,roundsStarted,maxGoalRounds,blockedReason?}, activation }`
  - `goalGuidance({ blockedAfterConsecutiveRounds? }) → string`

- [ ] **Step 1: Write the failing test**

`test/goal-bridge.test.mjs`:

```js
// test/goal-bridge.test.mjs — goal 桥接工具的语义与权限契约（对照 @deepseek-ai/dsh-tool-goal）。
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// --- 模块 mock：SDK 的构造器直通，便于直接拿到工具 handler ---
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    createSdkMcpServer: (opts) => opts,
    tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
  },
});

const { goalValue, resolveGoalConfig, goalGuidance, GOAL_TOOL_PREFIX } = await import("../lib/goal-bridge.mjs");

test("goalValue：无当前 goal → { goal: null }", () => {
  assert.deepEqual(goalValue(undefined), { goal: null });
});

test("goalValue：投影出 id/revision/objective/phase/轮数，blocked 带 reason", () => {
  const value = goalValue({
    id: "g1", revision: 2, objective: "do it", phase: "blocked",
    roundsStarted: 3, maxGoalRounds: 10, activation: "disarmed",
    blockedReason: { code: "model-reported", message: "no access" },
  });
  assert.deepEqual(value, {
    goal: {
      id: "g1", revision: 2, objective: "do it", phase: "blocked",
      roundsStarted: 3, maxGoalRounds: 10,
      blockedReason: { code: "model-reported", message: "no access" },
    },
    activation: "disarmed",
  });
});

test("resolveGoalConfig：默认阈值 3；非法阈值/上限抛 TypeError", () => {
  assert.deepEqual(resolveGoalConfig({}), { blockedAfterConsecutiveRounds: 3 });
  assert.deepEqual(resolveGoalConfig({ blockedAfterConsecutiveRounds: 5, defaultMaxGoalRounds: 64 }), {
    blockedAfterConsecutiveRounds: 5, defaultMaxGoalRounds: 64,
  });
  assert.throws(() => resolveGoalConfig({ blockedAfterConsecutiveRounds: 0 }), TypeError);
  assert.throws(() => resolveGoalConfig({ defaultMaxGoalRounds: 0 }), TypeError);
});

test("goalGuidance：把阈值插进策略文本", () => {
  assert.match(goalGuidance({ blockedAfterConsecutiveRounds: 7 }), /at least 7 consecutive goal rounds/);
});

test("GOAL_TOOL_PREFIX：canUseTool 放行前缀与 server 名一致", () => {
  assert.equal(GOAL_TOOL_PREFIX, "mcp__goal__");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-test-module-mocks test/goal-bridge.test.mjs`
Expected: FAIL —— `Cannot find module '.../lib/goal-bridge.mjs'`。

- [ ] **Step 3: Write minimal implementation**

`lib/goal-bridge.mjs`:

```js
// lib/goal-bridge.mjs — 把 goal 领域的模型工具桥接进 Claude Code（进程内 MCP server）。
//
// goal 服务（ctx.goals）、round driver、`/goal` 命令都在 host 平面；Claude Code 走 SDK 自带
// 工具系统，看不到 DSH 的 agent-scope 工具（dsh-tool-goal 的 get_goal/create_goal/update_goal）。
// 这里用 createSdkMcpServer 在同一进程暴露这三个工具，后端直接调 ctx.goals。
//
// 语义与权限刻意对齐 @deepseek-ai/dsh-tool-goal，但**不**复用它导出的 authority 模块（未导出，
// 且依赖 sessionProjections 的 turnBoundary 投影——本插件的引擎未必产出该投影）。改用 agent
// 自己记录的当前回合上下文（ClaudeCodeAgent.currentTurnContext()）。
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

export const GOAL_SERVER_NAME = "goal";
export const GOAL_TOOL_PREFIX = `mcp__${GOAL_SERVER_NAME}__`;

const UPDATE_ACTIONS = ["edit", "pause", "resume", "complete", "blocked"];

const GET_DESCRIPTION = "Read the current session goal, including the id and revision that update_goal requires.";
const CREATE_DESCRIPTION =
  'Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the direct human request is a long-running objective, even if the user did not say "goal"; not for single-turn work.';
const UPDATE_DESCRIPTION = "Update the current goal.";

/** 严格 schema 的空串 / 零值视为「未提供」（与 dsh-tool-goal 同款）。 */
function hasText(value) {
  return value !== undefined && value !== "";
}
function hasRoundCap(value) {
  return value !== undefined && value !== 0;
}

/** 配置归一化（apply 被直接调用、绕过 Loader 时仍校验）。 */
export function resolveGoalConfig(config = {}) {
  const blockedAfter = config.blockedAfterConsecutiveRounds ?? 3;
  if (!Number.isSafeInteger(blockedAfter) || blockedAfter < 1) {
    throw new TypeError("blockedAfterConsecutiveRounds must be a positive safe integer");
  }
  const out = { blockedAfterConsecutiveRounds: blockedAfter };
  if (config.defaultMaxGoalRounds !== undefined) {
    if (!Number.isSafeInteger(config.defaultMaxGoalRounds) || config.defaultMaxGoalRounds < 1) {
      throw new TypeError("defaultMaxGoalRounds must be a positive safe integer");
    }
    out.defaultMaxGoalRounds = config.defaultMaxGoalRounds;
  }
  return out;
}

/** 与 dsh-tool-goal 相同的紧凑模型结果；activation 是实时观察值，绝不作为回放依据。 */
export function goalValue(goal) {
  if (goal === undefined) return { goal: null };
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined
        ? {}
        : { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } }),
    },
    activation: goal.activation,
  };
}

/** 策略提示文本（含阻塞阈值），语义与 dsh-tool-goal 一致。 */
export function goalGuidance({ blockedAfterConsecutiveRounds = 3 } = {}) {
  return (
    "create_goal may infer goal intent from a direct human request in any language. " +
    "After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any " +
    "wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is " +
    `actually achieved. Mark blocked only after the same blocking condition persists for at least ${blockedAfterConsecutiveRounds} ` +
    "consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful " +
    "remaining work is not blocked."
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-test-module-mocks test/goal-bridge.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/goal-bridge.mjs test/goal-bridge.test.mjs
git commit -m "feat(goal): goal-bridge projection/config/guidance helpers"
```

---

### Task 3: `buildGoalServer` 骨架 + `get_goal`

**Files:**
- Modify: `lib/goal-bridge.mjs`
- Test: `test/goal-bridge.test.mjs`

**Interfaces:**
- Consumes: `goalValue`、`resolveGoalConfig`（Task 2）。
- Produces: `buildGoalServer({ ctx, agent, turnContext, config }) → { name, tools:[…] } | undefined`
  - `ctx.get("goals")` 为 undefined → 返回 `undefined`。
  - `turnContext` 是函数（返回 `{ hasHumanMessage, goalSource }`）。
  - 测试用假 SDK：`buildGoalServer` 返回的对象的 `tools` 是 `tool()` 原样返回项，含 `.name` 与 `.handler`。

- [ ] **Step 1: Write the failing test**（追加到 `test/goal-bridge.test.mjs`）

```js
// ---------------------------------------------------------------------------
// buildGoalServer + get_goal
// ---------------------------------------------------------------------------
const { buildGoalServer } = await import("../lib/goal-bridge.mjs");

/** 一个记录调用的假 ctx：goals 服务 + 最小 agents 注册表。 */
function fakeCtx(goals, agent) {
  return {
    get: (key) => (key === "goals" ? goals : undefined),
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      currentInitiator: () => agent,
    },
  };
}
const runningAgent = { id: "a1", status: "running" };
const toolOf = (server, name) => server.tools.find((t) => t.name === name);

test("无 goals 服务 → buildGoalServer 返回 undefined（功能静默缺席）", () => {
  const ctx = { get: () => undefined, agents: {} };
  assert.equal(buildGoalServer({ ctx, agent: runningAgent, turnContext: () => ({}), config: {} }), undefined);
});

test("get_goal：无当前 goal → { goal: null }", async () => {
  const goals = { get: () => undefined };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: false }), config: {} });
  const result = await toolOf(server, "get_goal").handler({});
  assert.deepEqual(JSON.parse(result.content[0].text), { goal: null });
});

test("get_goal：有 goal → 返回投影与 activation", async () => {
  const goal = { id: "g1", revision: 1, objective: "x", phase: "active", roundsStarted: 0, maxGoalRounds: 8, activation: "armed" };
  const goals = { get: () => goal };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({}), config: {} });
  const value = JSON.parse((await toolOf(server, "get_goal").handler({})).content[0].text);
  assert.equal(value.goal.id, "g1");
  assert.equal(value.activation, "armed");
});

test("get_goal：goals.get 抛异常 → isError，不外抛", async () => {
  const goals = { get: () => { throw new Error("boom"); } };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({}), config: {} });
  const result = await toolOf(server, "get_goal").handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /boom/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-test-module-mocks test/goal-bridge.test.mjs`
Expected: FAIL —— `buildGoalServer is not a function`。

- [ ] **Step 3: Write minimal implementation**（追加到 `lib/goal-bridge.mjs`）

```js
/** 成功结果：紧凑 JSON 文本。 */
function ok(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
/** 失败结果：可读文本；绝不外抛，避免打断 Claude 回合。 */
function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}
/** 调用者归属由构造时绑定的 agent 决定，不用 ALS 的 currentInitiator（未必传播进 SDK 派发）。 */
function assertCaller(ctx, agent) {
  if (agent === undefined) throw new Error("goal tools require a calling agent");
  if (ctx.agents.get(agent.id) !== agent) throw new Error("goal tools require the exact live calling agent");
  if (agent.status !== "running") throw new Error("goal tools require the calling agent to be running");
}
/** 一次工具调用共用的解析：活的调用者 + 当前回合上下文。 */
function resolveExecution(ctx, agent, turnContext) {
  assertCaller(ctx, agent);
  const turn = typeof turnContext === "function" ? turnContext() : turnContext;
  if (turn === undefined || turn === null) throw new Error("goal tools require an open model turn");
  return { agent, turn };
}

/**
 * 构造进程内 goal MCP server；无 goals 服务时返回 undefined（调用方据此不挂载）。
 * @param {object} args
 * @param {object} args.ctx 宿主上下文
 * @param {object} args.agent 当前 ClaudeCodeAgent（goal 归属）
 * @param {() => {hasHumanMessage:boolean, goalSource?:object}} args.turnContext 当前回合上下文访问器
 * @param {object} [args.config] 引擎的 goal 配置
 */
export function buildGoalServer({ ctx, agent, turnContext, config } = {}) {
  const goals = ctx.get?.("goals");
  if (goals === undefined) return undefined;
  const resolved = resolveGoalConfig(config);

  const tools = [
    tool("get_goal", GET_DESCRIPTION, {}, async () => {
      try {
        const ex = resolveExecution(ctx, agent, turnContext);
        return ok(goalValue(goals.get(ex.agent)));
      } catch (error) {
        return fail(error);
      }
    }),
  ];

  return createSdkMcpServer({ name: GOAL_SERVER_NAME, version: "1.0.0", tools });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-test-module-mocks test/goal-bridge.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/goal-bridge.mjs test/goal-bridge.test.mjs
git commit -m "feat(goal): buildGoalServer skeleton and get_goal"
```

---

### Task 4: `create_goal`（需人类直接回合）

**Files:**
- Modify: `lib/goal-bridge.mjs`
- Test: `test/goal-bridge.test.mjs`

**Interfaces:**
- Consumes: `resolveExecution`、`ok`、`fail`（Task 3）、`resolved.defaultMaxGoalRounds`。
- Produces: 名为 `create_goal` 的工具；input `{ objective: string, max_goal_rounds?: number }`。
  - `turn.hasHumanMessage !== true` → `isError`，文案含 `direct human`。
  - 成功 → `goals.create(agent, { objective, maxGoalRounds? })`，其中 `maxGoalRounds = args.max_goal_rounds ?? resolved.defaultMaxGoalRounds`（两者皆 undefined 则省略）。

- [ ] **Step 1: Write the failing test**（追加）

```js
test("create_goal：无人类直接回合 → 拒绝（isError）", async () => {
  const goals = { create: () => { throw new Error("should not be called"); } };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: false }), config: {} });
  const result = await toolOf(server, "create_goal").handler({ objective: "x" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /direct human/);
});

test("create_goal：人类回合 → 调 goals.create，透传 objective", async () => {
  const calls = [];
  const goals = { create: (agent, request) => { calls.push([agent, request]); return { id: "g1", revision: 1, objective: request.objective, phase: "active", roundsStarted: 0, maxGoalRounds: 256, activation: "armed" }; } };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: true }), config: {} });
  const value = JSON.parse((await toolOf(server, "create_goal").handler({ objective: "ship it" })).content[0].text);
  assert.deepEqual(calls[0][1], { objective: "ship it" });
  assert.equal(value.goal.id, "g1");
});

test("create_goal：未给 max_goal_rounds 时用配置的 defaultMaxGoalRounds 兜底", async () => {
  const calls = [];
  const goals = { create: (_a, request) => { calls.push(request); return { id: "g1", revision: 1, objective: request.objective, phase: "active", roundsStarted: 0, maxGoalRounds: request.maxGoalRounds, activation: "armed" }; } };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: true }), config: { defaultMaxGoalRounds: 12 } });
  await toolOf(server, "create_goal").handler({ objective: "x" });
  assert.deepEqual(calls[0], { objective: "x", maxGoalRounds: 12 });
});

test("create_goal：显式 max_goal_rounds 覆盖默认", async () => {
  const calls = [];
  const goals = { create: (_a, request) => { calls.push(request); return { id: "g1", revision: 1, objective: request.objective, phase: "active", roundsStarted: 0, maxGoalRounds: request.maxGoalRounds, activation: "armed" }; } };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: true }), config: { defaultMaxGoalRounds: 12 } });
  await toolOf(server, "create_goal").handler({ objective: "x", max_goal_rounds: 3 });
  assert.deepEqual(calls[0], { objective: "x", maxGoalRounds: 3 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-test-module-mocks test/goal-bridge.test.mjs`
Expected: FAIL —— `toolOf(server, "create_goal")` 为 `undefined`。

- [ ] **Step 3: Write minimal implementation**（在 `tools` 数组内，紧跟 `get_goal` 之后追加）

```js
    tool(
      "create_goal",
      CREATE_DESCRIPTION,
      { objective: z.string(), max_goal_rounds: z.number().int().positive().optional() },
      async (args) => {
        try {
          const ex = resolveExecution(ctx, agent, turnContext);
          if (ex.turn.hasHumanMessage !== true) {
            throw new Error("create_goal requires a direct human turn on a top-level agent");
          }
          const maxGoalRounds = args.max_goal_rounds ?? resolved.defaultMaxGoalRounds;
          const goal = goals.create(ex.agent, {
            objective: args.objective,
            ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
          });
          return ok(goalValue(goal));
        } catch (error) {
          return fail(error);
        }
      },
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-test-module-mocks test/goal-bridge.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/goal-bridge.mjs test/goal-bridge.test.mjs
git commit -m "feat(goal): create_goal tool with direct-human authority"
```

---

### Task 5: `update_goal` — `edit` / `pause` / `resume`

**Files:**
- Modify: `lib/goal-bridge.mjs`
- Test: `test/goal-bridge.test.mjs`

**Interfaces:**
- Consumes: `resolveExecution`、`ok`、`fail`、`hasText`、`hasRoundCap`。
- Produces: 名为 `update_goal` 的工具；input `{ goal_id: string, revision: number, action: "edit"|"pause"|"resume"|"complete"|"blocked", objective?: string, max_goal_rounds?: number, blocked_reason?: string }`。
  - 本任务实现 `edit`/`pause`/`resume` 分支；`complete`/`blocked` 在 Task 6 补。
  - 需人类直接回合（`turn.hasHumanMessage !== true` → 拒绝）。
  - `resume` 且当前 goal 为 paused 且 id/revision 命中 → 拒绝（`the model cannot resume a paused goal`）。
  - `edit` 带 `blocked_reason` → 拒绝；`pause`/`resume` 带 `objective`/`max_goal_rounds`/`blocked_reason` → 拒绝。

- [ ] **Step 1: Write the failing test**（追加）

```js
/** 递增 revision 的假 goal 服务，够 edit/pause/resume 用。 */
function fakeGoals(initial) {
  const calls = [];
  let current = initial;
  const bump = (phase) => { current = { ...current, revision: current.revision + 1, phase }; return current; };
  return {
    calls,
    get: () => current,
    edit: (agent, ref, replacements) => { calls.push(["edit", ref, replacements]); return (current = { ...current, ...replacements, revision: current.revision + 1 }); },
    pause: (agent, ref) => { calls.push(["pause", ref]); return bump("paused"); },
    resume: (agent, ref) => { calls.push(["resume", ref]); return bump("active"); },
  };
}
const activeGoal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 0, maxGoalRounds: 8, activation: "armed" };
const humanTurn = () => ({ hasHumanMessage: true });

test("update_goal edit：人类回合 → 调 edit，替换 objective", async () => {
  const goals = fakeGoals(activeGoal);
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: humanTurn, config: {} });
  const value = JSON.parse((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "edit", objective: "new" })).content[0].text);
  assert.deepEqual(goals.calls[0], ["edit", { id: "g1", revision: 2 }, { objective: "new" }]);
  assert.equal(value.goal.objective, "new");
});

test("update_goal edit：无人类回合 → 拒绝", async () => {
  const goals = fakeGoals(activeGoal);
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: false }), config: {} });
  const result = await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "edit", objective: "new" });
  assert.equal(result.isError, true);
  assert.equal(goals.calls.length, 0);
});

test("update_goal pause/resume：人类回合可用", async () => {
  const goals = fakeGoals(activeGoal);
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: humanTurn, config: {} });
  assert.equal(JSON.parse((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "pause" })).content[0].text).goal.phase, "paused");
  assert.equal(JSON.parse((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 3, action: "resume" })).content[0].text).goal.phase, "active");
});

test("update_goal resume：目标是 paused 时拒绝（只能用户恢复）", async () => {
  const goals = fakeGoals({ ...activeGoal, phase: "paused" });
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: humanTurn, config: {} });
  const result = await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "resume" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cannot resume a paused goal/);
  assert.equal(goals.calls.length, 0);
});

test("update_goal：非法参数组合被拒（edit 带 blocked_reason / pause 带 objective）", async () => {
  const goals = fakeGoals(activeGoal);
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: humanTurn, config: {} });
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "edit", objective: "n", blocked_reason: "r" })).isError, true);
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "pause", objective: "n" })).isError, true);
  assert.equal(goals.calls.length, 0);
});

test("update_goal：goal_id/revision 非法 → 拒绝且不调服务", async () => {
  const goals = fakeGoals(activeGoal);
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: humanTurn, config: {} });
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: " ", revision: 2, action: "edit", objective: "n" })).isError, true);
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 0, action: "pause" })).isError, true);
  assert.equal(goals.calls.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-test-module-mocks test/goal-bridge.test.mjs`
Expected: FAIL —— `toolOf(server, "update_goal")` 为 `undefined`。

- [ ] **Step 3: Write minimal implementation**

先在模块顶部函数区补 `goalRef`：

```js
/** 从模型参数构造精确 compare-and-set ref。 */
function goalRef(goalId, revision) {
  if (typeof goalId !== "string" || goalId.length === 0 || goalId !== goalId.trim() || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("goal_id must be non-empty and revision must be a positive safe integer");
  }
  return { id: goalId, revision };
}
```

再在 `tools` 数组内追加（`complete`/`blocked` 分支留到 Task 6，这里对未知 action 先抛错）：

```js
    tool(
      "update_goal",
      UPDATE_DESCRIPTION,
      {
        goal_id: z.string(),
        revision: z.number().int().positive(),
        action: z.enum(UPDATE_ACTIONS),
        objective: z.string().optional(),
        max_goal_rounds: z.number().int().positive().optional(),
        blocked_reason: z.string().optional(),
      },
      async (args) => {
        try {
          const ex = resolveExecution(ctx, agent, turnContext);
          const ref = goalRef(args.goal_id, args.revision);
          const goaled = () => {
            if (ex.turn.hasHumanMessage !== true) {
              throw new Error("this goal operation requires a direct human turn on a top-level agent");
            }
          };
          if (args.action === "edit") {
            goaled();
            if (hasText(args.blocked_reason)) throw new Error("blocked_reason is valid only with action blocked");
            return ok(goalValue(goals.edit(ex.agent, ref, {
              ...(hasText(args.objective) ? { objective: args.objective } : {}),
              ...(hasRoundCap(args.max_goal_rounds) ? { maxGoalRounds: args.max_goal_rounds } : {}),
            })));
          }
          if (args.action === "pause" || args.action === "resume") {
            goaled();
            if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds) || hasText(args.blocked_reason)) {
              throw new Error("objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked");
            }
            const current = goals.get(ex.agent);
            if (args.action === "resume" && current?.id === ref.id && current.revision === ref.revision && current.phase === "paused") {
              throw new Error("the model cannot resume a paused goal; the user must resume it");
            }
            return ok(goalValue(args.action === "pause" ? goals.pause(ex.agent, ref) : goals.resume(ex.agent, ref)));
          }
          throw new Error(`unsupported update_goal action: ${args.action}`);
        } catch (error) {
          return fail(error);
        }
      },
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-test-module-mocks test/goal-bridge.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/goal-bridge.mjs test/goal-bridge.test.mjs
git commit -m "feat(goal): update_goal edit/pause/resume branches"
```

---

### Task 6: `update_goal` — `complete` / `blocked`（完成权威 + 阻塞阈值）

**Files:**
- Modify: `lib/goal-bridge.mjs`
- Test: `test/goal-bridge.test.mjs`

**Interfaces:**
- Consumes: `resolved.blockedAfterConsecutiveRounds`、`ex.turn.goalSource`、`ex.turn.hasHumanMessage`。
- Produces: `complete`/`blocked` 分支。
  - 完成权威 = 人类直接回合 **或** 当前 goal round（`turn.goalSource` 与当前 goal 的 `id/revision/roundsStarted` 精确匹配）。
  - 两者皆无 → 拒绝（`complete and blocked require ...`）。
  - `blocked` 必须给非空（trim 后）`blocked_reason`；在 goal round 中要求 `goal.roundsStarted >= blockedAfterConsecutiveRounds`，否则拒绝。
  - `complete` 带 `blocked_reason`、`complete`/`blocked` 带 `objective`/`max_goal_rounds` → 拒绝。
  - 落库：`goals.block(agent, ref, { code: "model-reported", message: blocked_reason })`。

- [ ] **Step 1: Write the failing test**（追加）

```js
/** 假 goal 服务补 complete/block。 */
function fakeGoals2(initial) {
  const calls = [];
  return {
    calls,
    get: () => initial,
    complete: (agent, ref) => { calls.push(["complete", ref]); return { ...initial, phase: "complete", revision: initial.revision + 1, activation: "disarmed" }; },
    block: (agent, ref, reason) => { calls.push(["block", ref, reason]); return { ...initial, phase: "blocked", revision: initial.revision + 1, activation: "disarmed", blockedReason: reason }; },
  };
}

test("complete：goal round 内允许（goalSource 与当前 goal 精确匹配）", async () => {
  const goal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 1, maxGoalRounds: 8, activation: "armed" };
  const goals = fakeGoals2(goal);
  const turn = () => ({ hasHumanMessage: false, goalSource: { kind: "goal", goalId: "g1", revision: 2, round: 1 } });
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: turn, config: {} });
  const value = JSON.parse((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "complete" })).content[0].text);
  assert.deepEqual(goals.calls[0], ["complete", { id: "g1", revision: 2 }]);
  assert.equal(value.goal.phase, "complete");
});

test("complete：既无人类回合也无匹配 goal round → 拒绝", async () => {
  const goal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 1, maxGoalRounds: 8, activation: "armed" };
  const goals = fakeGoals2(goal);
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: false, goalSource: { kind: "goal", goalId: "g1", revision: 2, round: 5 } }), config: {} });
  const result = await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "complete" });
  assert.equal(result.isError, true);
  assert.equal(goals.calls.length, 0);
});

test("blocked：低于阈值拒绝，达到阈值通过并带 model-reported reason", async () => {
  const goal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 2, maxGoalRounds: 8, activation: "armed" };
  const goals = fakeGoals2(goal);
  const turn = () => ({ hasHumanMessage: false, goalSource: { kind: "goal", goalId: "g1", revision: 2, round: 2 } });
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: turn, config: { blockedAfterConsecutiveRounds: 3 } });
  const rejected = await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "blocked", blocked_reason: "no access" });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /at least 3 consecutive goal rounds/);

  // 达到阈值：roundsStarted=3 的 goal
  goals.get = () => ({ ...goal, roundsStarted: 3 });
  const server2 = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: false, goalSource: { kind: "goal", goalId: "g1", revision: 2, round: 3 } }), config: { blockedAfterConsecutiveRounds: 3 } });
  const okValue = JSON.parse((await toolOf(server2, "update_goal").handler({ goal_id: "g1", revision: 2, action: "blocked", blocked_reason: "no access" })).content[0].text);
  assert.deepEqual(goals.calls.at(-1), ["block", { id: "g1", revision: 2 }, { code: "model-reported", message: "no access" }]);
  assert.equal(okValue.goal.phase, "blocked");
});

test("blocked：缺 blocked_reason / 仅空白 → 拒绝", async () => {
  const goal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 3, maxGoalRounds: 8, activation: "armed" };
  const goals = fakeGoals2(goal);
  const turn = () => ({ hasHumanMessage: false, goalSource: { kind: "goal", goalId: "g1", revision: 2, round: 3 } });
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: turn, config: { blockedAfterConsecutiveRounds: 3 } });
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "blocked" })).isError, true);
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "blocked", blocked_reason: "   " })).isError, true);
  assert.equal(goals.calls.length, 0);
});

test("complete 带 blocked_reason / complete 带 objective → 拒绝", async () => {
  const goal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 3, maxGoalRounds: 8, activation: "armed" };
  const goals = fakeGoals2(goal);
  const turn = () => ({ hasHumanMessage: true });
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: turn, config: {} });
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "complete", blocked_reason: "r" })).isError, true);
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "complete", objective: "n" })).isError, true);
  assert.equal(goals.calls.length, 0);
});

test("领域错误（revision 过期）→ isError，不外抛", async () => {
  const goals = { get: () => ({ id: "g1", revision: 9, objective: "x", phase: "active", roundsStarted: 3, maxGoalRounds: 8, activation: "armed" }), complete: () => { const e = new Error("goal complete does not preserve the current counters"); e.code = "GOAL_CONFLICT"; throw e; } };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: true }), config: {} });
  const result = await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "complete" });
  assert.equal(result.isError, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-test-module-mocks test/goal-bridge.test.mjs`
Expected: FAIL —— `complete`/`blocked` 落到 `unsupported update_goal action`。

- [ ] **Step 3: Write minimal implementation**

在模块函数区补完成权威判定：

```js
/** 当前回合是否是当前 goal 的精确已准入轮次。 */
function isMatchingGoalRound(turn, goal) {
  const source = turn?.goalSource;
  return (
    source !== undefined &&
    goal !== undefined &&
    source.goalId === goal.id &&
    source.revision === goal.revision &&
    source.round === goal.roundsStarted
  );
}
/** 完成权威：人类直接回合，或当前 goal 的精确轮次。 */
function completionAuthority(turn, goal) {
  if (turn?.hasHumanMessage === true) return { kind: "direct-human" };
  if (isMatchingGoalRound(turn, goal)) return { kind: "goal-round", goal };
  throw new Error("complete and blocked require a direct human turn or the current goal round");
}
```

把 Task 5 里的 `throw new Error(\`unsupported update_goal action: ${args.action}\`)` 替换为 `complete`/`blocked` 分支：

```js
          const authority = completionAuthority(ex.turn, goals.get(ex.agent));
          if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds)) {
            throw new Error("objective and max_goal_rounds are valid only with action edit");
          }
          if (args.action === "complete" && hasText(args.blocked_reason)) {
            throw new Error("blocked_reason is valid only with action blocked");
          }
          if (args.action === "blocked" && (args.blocked_reason === undefined || args.blocked_reason.trim().length === 0)) {
            throw new Error("blocked_reason is required with action blocked");
          }
          if (args.action === "blocked" && authority.kind === "goal-round" && authority.goal.roundsStarted < resolved.blockedAfterConsecutiveRounds) {
            throw new Error(
              `blocked requires at least ${resolved.blockedAfterConsecutiveRounds} consecutive goal rounds; current round is ${authority.goal.roundsStarted}`,
            );
          }
          return ok(goalValue(
            args.action === "complete"
              ? goals.complete(ex.agent, ref)
              : goals.block(ex.agent, ref, { code: "model-reported", message: args.blocked_reason }),
          ));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-test-module-mocks test/goal-bridge.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/goal-bridge.mjs test/goal-bridge.test.mjs
git commit -m "feat(goal): update_goal complete/blocked with completion authority"
```

---

### Task 7: `ClaudeCodeAgent` 记录当前回合上下文

**Files:**
- Modify: `lib/agent.mjs`
- Test: `test/agent.test.mjs`

**Interfaces:**
- Produces: `ClaudeCodeAgent.currentTurnContext() → { hasHumanMessage: boolean, goalSource?: { kind:"goal", goalId, revision, round } }`。
  - 只反映**当前回合**被 claim 的消息；回合收尾后为空。
  - `hasHumanMessage`：本回合任一条消息 `source.kind === "user"`。
  - `goalSource`：本回合第一条 `source.kind === "goal"` 的消息的 source。
- Consumes: 无。

- [ ] **Step 1: Write the failing test**（改 `test/agent.test.mjs`）

把顶部 mock 的 `runClaudeCode` 改为在**运行中**快照一次 turnContext：

```js
    runClaudeCode: async (options) => {
      runCalls.push({ ...options, turnContextSnapshot: typeof options.turnContext === "function" ? options.turnContext() : undefined });
      return { ...runResult };
    },
```

把 `driveOneTurn` 改为可传消息，并返回 agent：

```js
/** 驱动一个完整回合；返回 { session, timeline, agent }。 */
async function driveOneTurn(message = { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] }) {
  const timeline = [];
  const session = fakeSession(timeline);
  const ctx = new Context();
  ctx.provide("agents", { withInitiator: async (_agent, fn) => fn() });
  const agent = new ClaudeCodeAgent(ctx, "agent-1", {}, session, { traceSubagents: false });
  agent.dispatch = fakeDispatch(timeline);
  agent.inbox = {
    nextTurn: [message],
    claim: (_target, _turn) => { agent.inbox.nextTurn = []; return [message]; },
  };
  agent.wakeDriver();
  await agent.whenIdle();
  return { session, timeline, agent };
}
```

追加测试：

```js
test("currentTurnContext：人类消息回合 → hasHumanMessage 为真、无 goalSource；回合后清空", async () => {
  const { agent } = await driveOneTurn({ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] });
  const snapshot = runCalls.at(-1).turnContextSnapshot;
  assert.deepEqual(snapshot, { hasHumanMessage: true, goalSource: undefined });
  assert.deepEqual(agent.currentTurnContext(), { hasHumanMessage: false, goalSource: undefined }, "回合结束后必须清空");
});

test("currentTurnContext：goal round → 捕获 goalSource、hasHumanMessage 为假", async () => {
  const source = { kind: "goal", goalId: "g1", revision: 1, round: 1 };
  const { agent } = await driveOneTurn({ role: "user", source, content: [{ type: "text", text: "<goal_round>…" }] });
  const snapshot = runCalls.at(-1).turnContextSnapshot;
  assert.equal(snapshot.hasHumanMessage, false);
  assert.deepEqual(snapshot.goalSource, source);
  assert.deepEqual(agent.currentTurnContext(), { hasHumanMessage: false, goalSource: undefined });
});
```

（`runCalls` 在每个测试前不需要清空——用 `.at(-1)` 取最近一次。）

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-test-module-mocks test/agent.test.mjs`
Expected: FAIL —— `runCalls.at(-1).turnContextSnapshot` 为 `undefined`，且 `agent.currentTurnContext is not a function`。

- [ ] **Step 3: Write minimal implementation**（`lib/agent.mjs`）

构造函数内追加字段（`this.pendingResume = undefined;` 之后）：

```js
    /** 当前回合的 claimed 消息（供 goal 桥接工具做权限判定）；回合收尾后清空。 */
    this.currentTurn = undefined;
```

`drive()` 内，在 `const messages = this.inbox.claim("next-turn", turn);` 之后：

```js
        this.currentTurn = { turn, messages };
```

并给现有的 `try { … } catch (error) { … }` 补 `finally`（在 `catch` 块之后、`}` 之前）：

```js
        } finally {
          this.currentTurn = undefined;
        }
```

新增方法（放在 `#endReason` 之前）：

```js
  /**
   * 当前回合上下文，供 goal 桥接工具判定「人类直接回合」与「goal round」。
   * @returns {{ hasHumanMessage: boolean, goalSource?: object }}
   */
  currentTurnContext() {
    const messages = this.currentTurn?.messages ?? [];
    let hasHumanMessage = false;
    let goalSource;
    for (const message of messages) {
      const source = message?.source;
      if (source?.kind === "user") hasHumanMessage = true;
      else if (source?.kind === "goal" && goalSource === undefined) goalSource = source;
    }
    return { hasHumanMessage, goalSource };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-test-module-mocks test/agent.test.mjs`
Expected: PASS（含既有两条回合收尾用例）。

- [ ] **Step 5: Commit**

```bash
git add lib/agent.mjs test/agent.test.mjs
git commit -m "feat(goal): record per-turn context on ClaudeCodeAgent"
```

---

### Task 8: `canUseTool` 放行 goal 桥接工具

**Files:**
- Modify: `lib/approval.mjs`
- Test: `test/approval.test.mjs`

**Interfaces:**
- Consumes: `GOAL_TOOL_PREFIX`（Task 2）——用字符串 `"mcp__goal__"` 前缀匹配。
- Produces: `canUseTool` 在策略短路**之前**对 `mcp__goal__*` 返回 `{ behavior: "allow" }`。

- [ ] **Step 1: Write the failing test**（追加到 `test/approval.test.mjs`）

```js
test("goal 桥接工具在 no-prompt（never）下仍放行，且早于策略短路", async () => {
  const canUseTool = makeCanUseTool(baseCtx(undefined), {
    cwd: "/w",
    session: sessionWith([ev("sandbox/mode", { mode: "workspace-write" }), ev("approval/policy", { policy: "never" })]),
    agent: { id: "a1" },
  });
  assert.deepEqual(await canUseTool("mcp__goal__get_goal", {}), { behavior: "allow" });
  assert.deepEqual(await canUseTool("mcp__goal__update_goal", { action: "complete" }), { behavior: "allow" });
  // 非 goal 的 MCP 工具不受此放行影响
  assert.equal((await canUseTool("mcp__other__x", {})).behavior, "deny");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-test-module-mocks test/approval.test.mjs`
Expected: FAIL —— 第一个断言得到 `deny`。

- [ ] **Step 3: Write minimal implementation**（`lib/approval.mjs`）

在 `canUseTool` 内，紧跟 AskUserQuestion 分支之后、`permissionStrategy(...)` 之前插入：

```js
    // goal 桥接工具（mcp__goal__*）是进程内、无副作用、且自带领域权限判定的交互，
    // 不受沙箱/审批门控。必须早于下面的 strategy 短路，否则 no-prompt（never）会被一律拒绝。
    if (toolName.startsWith("mcp__goal__")) return { behavior: "allow" };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-test-module-mocks test/approval.test.mjs`
Expected: PASS（含既有 5 条）。

- [ ] **Step 5: Commit**

```bash
git add lib/approval.mjs test/approval.test.mjs
git commit -m "feat(goal): allow goal bridge tools before permission short-circuits"
```

---

### Task 9: `runClaudeCode` 挂载 MCP server 与策略提示

**Files:**
- Modify: `lib/claude-run.mjs`、`lib/agent.mjs`
- Test: `test/goal-run.test.mjs`（新）

**Interfaces:**
- Consumes: `buildGoalServer`、`goalGuidance`、`resolveGoalConfig`（Task 2/3）；`agent.currentTurnContext()`（Task 7）。
- Produces:
  - `runClaudeCode(options)` 新增可选参数 `turnContext`（函数）。
  - `config.goal.enabled !== false` 且 `ctx.get("goals")` 存在时，`options.mcpServers = { goal: <server> }`、`options.systemPrompt = { type:"preset", preset:"claude_code", append: goalGuidance(resolved) }`。
  - 否则两键都不出现。
  - `ClaudeCodeAgent.drive()` 向 `runClaudeCode` 传 `turnContext: () => this.currentTurnContext()`。

- [ ] **Step 1: Write the failing test**

`test/goal-run.test.mjs`:

```js
// test/goal-run.test.mjs — runClaudeCode 对 goal 桥接的 options 组装。
import { test, mock } from "node:test";
import assert from "node:assert/strict";

let capturedOptions = [];
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: ({ options }) => { capturedOptions.push(options); return (async function* empty() {})(); },
    createSdkMcpServer: (opts) => opts,
    tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
  },
});
const { runClaudeCode } = await import("../lib/claude-run.mjs");

const ev = (type, data) => ({ type, data, seq: 0 });
const session = {
  id: "s1", append() {}, requestContext: () => undefined, requestHeader: () => undefined,
  snapshotEvents: () => [ev("sandbox/mode", { mode: "workspace-write" }), ev("approval/policy", { policy: "ask" })],
};
const goalStub = { get: () => undefined };
const ctxWithGoals = { get: (k) => (k === "goals" ? goalStub : undefined), logger: { warn() {}, info() {} } };
const ctxNoGoals = { get: () => undefined, logger: { warn() {}, info() {} } };
const base = {
  session, agent: { id: "a1", status: "running" }, turn: 1, prompt: "hi",
  signal: new AbortController().signal, cwd: "/w", executable: "claude", env: {},
  turnContext: () => ({ hasHumanMessage: true }),
};

test("goal 开启且有 goals 服务 → options 含 mcpServers.goal 与 systemPrompt.append", async () => {
  capturedOptions = [];
  await runClaudeCode({ ctx: ctxWithGoals, config: {}, ...base });
  const options = capturedOptions[0];
  assert.equal(options.mcpServers.goal.name, "goal");
  assert.equal(options.mcpServers.goal.tools.length, 3);
  assert.equal(options.systemPrompt.type, "preset");
  assert.match(options.systemPrompt.append, /consecutive goal rounds/);
});

test("goal.enabled=false → 不挂 mcpServers / systemPrompt", async () => {
  capturedOptions = [];
  await runClaudeCode({ ctx: ctxWithGoals, config: { goal: { enabled: false } }, ...base });
  assert.equal(capturedOptions[0].mcpServers, undefined);
  assert.equal(capturedOptions[0].systemPrompt, undefined);
});

test("无 goals 服务 → 不挂 mcpServers / systemPrompt", async () => {
  capturedOptions = [];
  await runClaudeCode({ ctx: ctxNoGoals, config: {}, ...base });
  assert.equal(capturedOptions[0].mcpServers, undefined);
  assert.equal(capturedOptions[0].systemPrompt, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-test-module-mocks test/goal-run.test.mjs`
Expected: FAIL —— `options.mcpServers` 为 `undefined`。

- [ ] **Step 3: Write minimal implementation**

`lib/claude-run.mjs` 顶部 import 追加：

```js
import { buildGoalServer, goalGuidance, resolveGoalConfig, GOAL_SERVER_NAME } from "./goal-bridge.mjs";
```

在 `runClaudeCode({ … })` 解构参数里追加 `turnContext`（与 `agent` 相邻）：

```js
  turnContext,
```

在 `const options = {` 之前构造 goal 选项：

```js
  // goal 桥接：把 get_goal/create_goal/update_goal 以进程内 MCP server 暴露给 Claude Code，
  // 并追加 goal 策略提示。无 goals 服务或显式关闭时两者都不挂。
  const goalServer = config.goal?.enabled === false
    ? undefined
    : buildGoalServer({ ctx, agent, turnContext, config: config.goal });
  const goalOptions = goalServer === undefined
    ? {}
    : {
        mcpServers: { [GOAL_SERVER_NAME]: goalServer },
        systemPrompt: { type: "preset", preset: "claude_code", append: goalGuidance(resolveGoalConfig(config.goal)) },
      };
```

在 `options` 里、`supportedDialogKinds` 之后展开：

```js
    supportedDialogKinds: SUPPORTED_DIALOG_KINDS,
    ...goalOptions,
```

`lib/agent.mjs` 的 `runClaudeCode({ … })` 调用处追加：

```js
              turnContext: () => this.currentTurnContext(),
```

（加在 `agent: this,` 附近。）

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-test-module-mocks test/goal-run.test.mjs`
Expected: PASS。

- [ ] **Step 5: 回归全量测试**

Run: `pnpm test`
Expected: 全部 PASS（既有 54 + 新增）。

- [ ] **Step 6: Commit**

```bash
git add lib/claude-run.mjs lib/agent.mjs test/goal-run.test.mjs
git commit -m "feat(goal): expose goal MCP server and policy prompt to Claude Code"
```

---

### Task 10: 配置默认值与 `zod` 依赖

**Files:**
- Modify: `index.mjs`、`package.json`

**Interfaces:**
- Produces: `ENGINE_DEFAULTS.goal = { enabled: true, blockedAfterConsecutiveRounds: 3 }`（`defaultMaxGoalRounds` 可选，默认不设，走 host 默认 256）。
- Produces: `package.json` 的 `dependencies` 含 `"zod": "^4.0.0"`。

- [ ] **Step 1: 改 `index.mjs` 的 `ENGINE_DEFAULTS`**

在 `ENGINE_DEFAULTS` 对象内、`contextWindow` 之后追加：

```js
  /** goal 模式：把 goal 工具桥接进 Claude Code，默认开（见 docs 的 goal 设计）。 */
  goal: {
    enabled: true,
    blockedAfterConsecutiveRounds: 3,
    /** 可选：仅在本插件 create_goal 且模型未给 max_goal_rounds 时透传。 */
    defaultMaxGoalRounds: undefined,
  },
```

- [ ] **Step 2: 改 `package.json`**

在 `dependencies` 内追加（保持字母序，放在 `@deepseek-ai/schemastery` 之后、`js-yaml` 之前）：

```json
    "@deepseek-ai/schemastery": "^3.18.4",
    "zod": "^4.0.0",
    "js-yaml": "^4.1.0"
```

- [ ] **Step 3: 安装并验证依赖解析**

Run: `pnpm install`
Expected: 无错误；`node -e "import('zod').then(()=>console.log('zod ok'))"` 打印 `zod ok`。

- [ ] **Step 4: 全量测试**

Run: `pnpm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add index.mjs package.json pnpm-lock.yaml
git commit -m "chore(goal): default goal config and declare zod dependency"
```

---

### Task 11: README 文档

**Files:**
- Modify: `README.md`（以及 `README_EN.md` 对应位置）

**Interfaces:** 无。

- [ ] **Step 1: 在「⚙️ 启用与配置」的 YAML 示例里，`engines.claude-code` 下补 `goal` 段**

```yaml
        traceSubagents: true
        goal:
          enabled: true                    # 默认开：把 goal 工具桥接进 Claude Code
          blockedAfterConsecutiveRounds: 3 # 同一阻塞条件连续多少轮才允许标记 blocked
          # defaultMaxGoalRounds: 256      # 可选：模型未给 max_goal_rounds 时的兜底
        env: {}
```

- [ ] **Step 2: 在配置表末追加三行**

```markdown
| `engines.claude-code.goal.enabled` | `true` | 是否把 `get_goal`/`create_goal`/`update_goal` 桥接进 Claude Code（会话可用 `/goal` 自动推进） |
| `engines.claude-code.goal.blockedAfterConsecutiveRounds` | `3` | 同一阻塞条件连续达到多少个 goal round 才允许模型标记 `blocked` |
| `engines.claude-code.goal.defaultMaxGoalRounds` | 未配置 | 模型调 `create_goal` 未给上限时的兜底轮数（默认走 DSH 的 256） |
```

- [ ] **Step 3: 在「✨ 能干什么」补一条**

```markdown
- **🎯 目标式自动任务**：选中 Claude Code 预设的会话支持标准模式那套 goal —— 输入 `/goal <目标>` 后自动一轮轮推进，Claude 用桥接的 `get_goal`/`update_goal` 读取并把目标收尾（complete/blocked）。开关 `engines.claude-code.goal.enabled`，默认开。
```

- [ ] **Step 4: 在「⚠️ 已知限制」补一条**

```markdown
- **goal 续跑依赖 DSH host 平面的 goal 栈**（`dsh-goal` + `dsh-goal-round-driver`）。未装该栈的部署里 `goal.enabled` 自动失效（不挂工具、不加提示），`/goal` 行为回落到 DSH 原生（若该预设未挂 `command-goal`，则无 `/goal` 命令）。
```

- [ ] **Step 5: Commit**

```bash
git add README.md README_EN.md
git commit -m "docs(goal): document Claude Code goal mode and its config"
```

---

### Task 12: 端到端验证（隔离 harness / 桌面 app）

**Files:** 无代码改动（观测 + 判定）。

**Interfaces:**
- Consumes: Task 2–11 的全部实现。

- [ ] **Step 1: 重启桌面应用**（链接安装下源码即时生效，但新依赖 `zod` 需重装 profile：`dsh plugin --profile desktop add <path>` 后再重启）。

- [ ] **Step 2: 新建「Claude Code」会话，执行 `/goal 在仓库根创建 goal-e2e.md，内容为 done`**

Expected：GoalBar 显示 active；会话自动开始第一轮。

- [ ] **Step 3: 观察多轮自动推进**

Expected：Claude 在 1–3 轮内创建文件；调用 `mcp__goal__get_goal` 读快照，再调用 `mcp__goal__update_goal action=complete`；此后不再自动续跑，GoalBar 显示 complete。

- [ ] **Step 4: 校验会话日志合法（不变量未触发、可 reopen）**

```bash
ls "C:/Users/Administrator/.dsh/sessions/"
node .dsh-diag/dump-session.mjs "<session.v4.jsonl.zstd>" | grep -nE "goal_round|goal/change" | head
```

Expected：`goal/change`(create) 在首个 `goal_round` 之前；`goal_round` 的 `round` 依次递增；无 `SessionFormatError`。关掉再打开该会话能正常加载。

- [ ] **Step 5: 反向验证：关闭开关**

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `dsh-claude-code` 行里设 `engines.claude-code.goal.enabled: false`，重启；新建 Claude Code 会话确认工具表里**没有** `mcp__goal__*`，且普通对话行为与改动前一致。

- [ ] **Step 6: 反向验证：非 Claude Code 会话零变化**

打开一个 standard 预设会话，确认行为与改动前一致（不涉及本插件引擎路径）。

- [ ] **Step 7: 记录结果**

若某一步失败，附上 `~/.dsh/dsh-claude-code/router-diag.log`、`%APPDATA%\@deepseek-ai\dsh-desktop\logs\` 与 session dump，回到对应 Task 修正。

*（本任务无 commit；如产生临时文件请清理。）*

---

## Self-Review

**1. Spec coverage：**

| Spec 节 | 覆盖任务 |
|---|---|
| §4.1 `lib/goal-bridge.mjs`（三工具/权限/输出/错误） | Task 2–6 |
| §4.2 `lib/agent.mjs`（currentTurn + 访问器） | Task 7 |
| §4.3 `lib/claude-run.mjs`（mcpServers + systemPrompt + turnContext） | Task 9 |
| §4.4 `lib/approval.mjs`（goal 工具放行） | Task 8 |
| §4.5 配置默认值 | Task 10 |
| §4.6 `zod` 依赖 | Task 10 |
| §5 会话不变量（只经 ctx.goals、原样转发） | 全局约束 + Task 12 Step 4 校验 |
| §6 错误处理与降级 | Task 3/4/5/6 错误路径 + Task 9「无 goals → 不挂」 |
| §7 单测 | Task 2–9 |
| §8 风险（pre-step / driver 可见性） | Task 1 前提门 + Task 12 |
| §10 验收标准 | Task 12 |

**2. Placeholder scan：** 无 TBD/TODO；各代码步骤均给出完整可运行代码。

**3. Type consistency：** `buildGoalServer` 全程签名一致；`turnContext()` 返回 `{ hasHumanMessage, goalSource }` 在 Task 7（产出）与 Task 3–6/9（消费）一致；`GOAL_SERVER_NAME`/`GOAL_TOOL_PREFIX` 在 Task 2 定义、Task 8/9 使用；`resolveGoalConfig`/`goalGuidance`/`goalValue` 名称全程一致。

**4. Review Focus：** 见文首 Review Focus 一节，五条已分别钉到 Task 3（无 goals / get 抛错）、Task 4（create 非人类）、Task 5/6（领域错误、blocked 阈值与空 reason）、Task 9（关闭时无 mcpServers/systemPrompt）的测试。

**已知测试调整：** spec §7 原写「扩展 `test/claude-run.test.mjs`」；因该文件用静态 import、无法在同文件加 `mock.module`，改为新建 `test/goal-run.test.mjs`（与既有 `approval.test.mjs` 的 mock 风格一致）。语义等价。
