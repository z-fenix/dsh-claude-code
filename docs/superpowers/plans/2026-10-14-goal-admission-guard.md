# Goal 日志准入与异步准备竞态保护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 推荐 Native（当前会话执行、最后一次 fresh review）；执行方式仍待用户确认。

**Goal:** 在插件输入路径阻止公开 goal 状态已失效的自动消息进入日志或模型，并保留混合输入、取消恢复与不重复登记的契约。

**Architecture:** 新增无副作用的公开 view 判定与独立的原生登记证据读取器；Agent 负责 exact pending 拒绝、重新准备与失败自动项暂挂，现有 inbox/ledger 继续负责持久化。初始日志准入检查下一轮，已登记首批的交付检查当前已准入轮，运行中自动 goal 一律拒绝；三者不得互换。宿主仍拥有目标状态、计数与自动驱动，不调用 whole agent/pre-step、不复制私有 reservation。

**Tech Stack:** Node ESM、node:test/module mocks、Cordis、现有 DSH 0.2.0-rc.2 Session/inbox/private facts、Claude Agent SDK 0.3.220；不增加依赖。Node 版本沿用 package.json 的 `^22.19.0 || >=24.0.0`。

**Spec:** `docs/superpowers/specs/2026-10-14-goal-admission-guard-design.md`。书面 spec 已在对话获批；其写入时的“待审阅”状态文字不是新的授权。本文是待审阅实施计划，尚未批准产品实现。

## Global Constraints

- 不修改 DSH app.asar，不安装全局 Claude 插件，不自动 commit/push，不运行未经批准的收费推理。
- 不修改正式 profile、全局 Claude settings 或正式/历史无效会话日志；不读取或导出认证秘密。
- 普通 followup 排队；steer 在安全边界插入；inject 不自己启动新的人类回合；显式 cancel 停止当前生成，keepInbox 保留待办。
- 不派发整个 `agent/pre-step`，不重复运行宿主的 prompt、工作区指令或压缩装配。
- 不访问或复制 goal-round-driver 私有 attempt，不另建 goal 状态、计数器或自动轮次生成器。
- 不改 source 为人类，不把消息正文、mod 参数或模型声明当作 continuation authority。
- MCP 与 mod 继续调用同一领域 handler；mod 未支持时保留 MCP，同一查询不重复暴露 goal 工具。
- 系统提示词快照不冒充最终全文，不向 request/header 写 system；子代理继续保持 one-shot，不伪造用量、不重写历史标题。
- 本文的审批不延伸到其它 parity 项、宿主接口开发、真实隔离模型验收或提交操作。
- 不读取或修复 event 9934 正式故障；不将本计划称为完整 standard reservation fence。
- 不重做已验收的 present/jobs 桥；保留当前工作区既有未提交修改，不 reset、stash、覆盖或批量 stage。
- 本计划不含 commit 步骤，以任务账本及完整 diff 留证。未来若另获提交授权，先解决默认分支提交策略，不能沿用旧批准自行提交。
- 所有测试使用内存 private facts 或本计划独占的临时目录；禁止落入默认 `~/.dsh`。不启动 Claude CLI 推理或 DSH GUI/web 服务。

## Review Focus

1. 原生 append 成功、紧随其后的 private fact 写入失败：重建后只能发现原登记，不能再 append 或把登记当 submitted（Task 2、3、4）。
2. 新 epoch 的 reservation 锚点已跨过旧 user/message：必须保留早期完整证据；重复 id、payload/source 冲突或读取失败均 fail closed（Task 2、5）。
3. claim、turn/start、前序 user/message 的同步监听器改变 goal 或 abort：写自动项前再校验；人类已登记项不重写，旧批次不进入模型（Task 3）。
4. goal 读取失败并同时出现 keepInbox/wakeRequested：自动项不忙循环，后续普通输入可越过暂挂自动项，纯 inject 仍不唤醒（Task 3、4）。
5. canSubmitInput 返回 false 而 pending 不变、或初始交付在 runner 的 await 后失效：不能重复调度、把 Promise 当布尔值或借日志异常处理普通准入拒绝（Task 4）。

---

## 实施前基线与文件职责

本计划针对已调查的当前工作区，不以 HEAD 的旧版本代替现有 bridge/input 实现。先读 spec、记录 `git status --short` / `git diff --stat`，运行一次 `pnpm test` 建立新基线。此前的 313/313 不是本计划验证证据。现有失败须按名称记录，不冒称由本任务引入，也不跳过报告。

| 文件 | 职责 / 改动边界 |
|---|---|
| 新 `lib/goal-admission.mjs` | 同步公开 view 判定，无 inbox/log/mutation 副作用 |
| `lib/goal-domain.mjs` | 仅重导出判定 API；不改已开放回合的工具权限规则 |
| 新 `lib/input-registration.mjs` | 由完整 private/native 历史发现原登记；不改变 submitted/observed 状态 |
| `lib/run-input.mjs` | 仅重导出登记 API；保留既有 ledger 状态机、原子 input-batch 提交 |
| `lib/inbox.mjs:153-162` | 增加兼容的 exact-object 删除选项，仍经持久 splice/通知 |
| `lib/agent.mjs:89-96,197-372` | 初始/active 边界、暂挂与恢复、selective prompt 重建、所有 user/message 写入口 |
| `lib/claude-run.mjs:1000-1086` 及 options 解构处 | 新首批同步交付检查；保留现有 mod/MCP 选择和 fallback |
| `lib/run-control.mjs` | 保持 canSubmitInput 同步契约；必要时显式拒绝非布尔返回，不改首批为 active 路径 |
| 新 `test/goal-admission.test.mjs` | source/view/lifecycle 判定矩阵 |
| 新 `test/input-registration.test.mjs` | 完整历史、冲突、读取失败、不同 epoch 的登记证据 |
| `test/inbox.test.mjs` | 同 id 替换后的 exact 删除保护 |
| `test/agent.test.mjs` | 生产 Agent + fake runner 的日志/claim/同步重入测试 |
| `test/run-control.test.mjs` | 生产 Agent/runner/controller + fake SDK 的交付与调度测试 |
| 新 `test/helpers/goal-fixture.mjs` | 只在测试中提供 exact registry 与可变公开 view；轮数只由 native user/message 更新 |
| `test/session-compatibility.test.mjs` | 真实 npm Session 重建与合成验证 artifact |
| 新 `test/helpers/validate-goal-session.cjs` | 安装版 v4 validator + foldGoal，只读本计划合成 artifact |
| `README.md`、`README_EN.md` | 用一致文案说明有限 guard 与未覆盖的原生 reservation |

测试命令均在仓库根运行：

```bash
node --test --experimental-test-module-mocks test/goal-admission.test.mjs
node --test --experimental-test-module-mocks test/input-registration.test.mjs test/inbox.test.mjs
node --test --experimental-test-module-mocks test/agent.test.mjs
node --test --experimental-test-module-mocks test/run-control.test.mjs
pnpm test
```

Expected：第一轮基线如有失败如实记录；每个 RED 必须是预期断言失败，不是 import/fixture 错误；每个任务结束完整 `pnpm test` 为零失败，否则不得标 complete。不把 Node 的实验性 module-mock 提示当产品失败；新增 warning/error 必须解释。

任务按 1 → 2 → 3 → 4 → 5 执行，不并行修改共享的 Agent/runner。计划中的代码块给出接口、主行为和关键接缝；保留原函数未涉及的生命周期、流式输出、恢复 Claude session id 与 tracer 收尾代码，不整文件覆盖。

### Task 1: 同步准入判定与 exact pending 拒绝

**Files:**
- Create: `lib/goal-admission.mjs`, `test/goal-admission.test.mjs`。
- Modify: `lib/goal-domain.mjs`（仅 exports）、`lib/inbox.mjs:153-162`、`test/inbox.test.mjs`。

**Interfaces:**
- Consumes: `readGoal: () => GoalView | undefined`，同步 `isLive: () => boolean`；`GoalView` 字段为 `id, revision, phase, activation, roundsStarted, maxGoalRounds`。
- Produces: `assessGoalAdmission({ messages, readGoal, isLive, active = false }): Decision`；`assessGoalDelivery({ messages, readGoal, isLive }): Decision`。
- `Decision` 为 `{ kind: "allow" }`、`{ kind: "reject", code: string, messages: UserMessage[] }` 或 `{ kind: "hold", code: string, messages: UserMessage[], error?: unknown }`。messages 保留传入对象身份。
- Produces: `DshInbox.remove(messageId, expectedMessage?): boolean`；旧单参数调用保持原语义，带 expected 时只能删除当前 exact 对象。

- [ ] **Step 1: 写失败测试。** 从已有 `goal-domain.mjs` namespace import 判定 API，使缺失函数通过 assertion 失败而不是 import 错误。第一条用非法 round 验证拒绝，不以“仅导出存在”结束测试。

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as domain from "../lib/goal-domain.mjs";

const goalMessage = (source = {}) => ({
  id: "g-msg", role: "user", content: [{ type: "text", text: "automatic" }],
  source: { kind: "goal", goalId: "g1", revision: 1, round: 1, ...source },
});
const view = (patch = {}) => ({ id: "g1", revision: 1, phase: "active",
  activation: "armed", roundsStarted: 0, maxGoalRounds: 3, ...patch });
const check = (messages, patch = {}) => {
  assert.equal(typeof domain.assessGoalAdmission, "function");
  return domain.assessGoalAdmission({ messages, readGoal: () => view(),
    isLive: () => true, ...patch });
};

for (const round of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`source-invalid round ${round} 不读取 goal`, () => {
    const message = goalMessage({ round });
    const decision = check([message], { readGoal() { assert.fail("must not read"); } });
    assert.deepEqual(decision, { kind: "reject", code: "source-invalid", messages: [message] });
  });
}
for (const [patch, code] of [
  [{ id: "old" }, "goal-mismatch"], [{ revision: 2 }, "goal-mismatch"],
  [{ phase: "paused" }, "goal-inactive"], [{ phase: "blocked" }, "goal-inactive"],
  [{ phase: "complete" }, "goal-inactive"], [{ activation: "disarmed" }, "goal-disarmed"],
  [{ roundsStarted: 1 }, "round-mismatch"], [{ maxGoalRounds: 0 }, "goal-read-failed"],
]) {
  test(`view ${JSON.stringify(patch)} 分类拒绝或暂挂`, () => {
    const decision = check([goalMessage()], { readGoal: () => view(patch) });
    assert.equal(decision.code, code);
    assert.equal(decision.kind, code === "goal-read-failed" ? "hold" : "reject");
  });
}
test("普通输入不依赖 goal 服务", () => {
  assert.deepEqual(check([{ id: "u", source: { kind: "system" } }], {
    readGoal() { assert.fail("must not read"); },
  }), { kind: "allow" });
});
test("读取错误保留原错误，不能变成没有目标", () => {
  const error = new Error("projection failed");
  const decision = check([goalMessage()], { readGoal() { throw error; } });
  assert.equal(decision.kind, "hold");
  assert.equal(decision.code, "goal-read-failed");
  assert.equal(decision.error, error);
  assert.equal(check([goalMessage()], { readGoal: () => undefined }).code, "goal-missing");
});
test("多 goal 不任取第一条", () => {
  const messages = [goalMessage(), { ...goalMessage(), id: "g2-msg" }];
  assert.deepEqual(check(messages), { kind: "reject", code: "multiple-goal-inputs", messages });
});
test("get 同步重入使 lifecycle 失效时暂挂", () => {
  let live = true;
  const decision = check([goalMessage()], { isLive: () => live,
    readGoal() { live = false; return view(); } });
  assert.equal(decision.code, "lifecycle-ended");
  assert.equal(decision.kind, "hold");
});
test("admission 下一轮和 delivery 当前轮不可互换", () => {
  const messages = [goalMessage()];
  assert.equal(check(messages).kind, "allow");
  assert.equal(check(messages, { readGoal: () => view({ roundsStarted: 1 }) }).code, "round-mismatch");
  assert.equal(typeof domain.assessGoalDelivery, "function");
  assert.equal(domain.assessGoalDelivery({ messages,
    readGoal: () => view({ roundsStarted: 1 }), isLive: () => true }).kind, "allow");
  assert.equal(domain.assessGoalDelivery({ messages,
    readGoal: () => view(), isLive: () => true }).code, "round-mismatch");
});
```

在已有 inbox fixture 的测试体中增加：

```js
const oldMessage = { id: "same", role: "user", content: [{ type: "text", text: "old" }] };
const replacement = { ...oldMessage, content: [{ type: "text", text: "new" }] };
inbox.append("next-turn", oldMessage);
inbox.replace("same", replacement);
const before = session.snapshotEvents().length;
assert.equal(inbox.remove("same", oldMessage), false);
assert.equal(inbox.nextTurn[0], replacement);
assert.equal(session.snapshotEvents().length, before);
assert.equal(inbox.remove("same", replacement), true);
assert.equal(inbox.nextTurn.length, 0);
```

同时把以下测试追加到同文件，覆盖其它格式、上限和同步返回契约：

```js
for (const source of [{ goalId: "" }, { revision: 0 }, { revision: 1.5 }]) {
  test(`非法 source ${JSON.stringify(source)}`, () => {
    assert.equal(check([goalMessage(source)]).code, "source-invalid");
  });
}
test("跳轮和超限分别拒绝", () => {
  assert.equal(check([goalMessage({ round: 2 })]).code, "round-mismatch");
  assert.equal(check([goalMessage({ round: 4 })], {
    readGoal: () => view({ roundsStarted: 3 }),
  }).code, "round-limit");
});
test("多个 goal 中一条合法也不能部分授权", () => {
  const messages = [goalMessage(), { ...goalMessage({ round: 0 }), id: "bad" }];
  assert.deepEqual(check(messages), { kind: "reject", code: "multiple-goal-inputs", messages });
});
test("active 自动项不进入模型提交准入或读取 goal", () => {
  const decision = check([goalMessage()], { active: true,
    readGoal() { assert.fail("active goal is unsupported"); } });
  assert.equal(decision.code, "unsupported-active-goal-input");
});
test("Promise view 和缺失服务都暂挂", () => {
  assert.equal(check([goalMessage()], { readGoal: () => Promise.resolve(view()) }).code, "goal-read-failed");
  assert.equal(check([goalMessage()], { readGoal: undefined }).code, "goal-read-failed");
});
```

不将已完成目标 phase 拼成不存在的 `completed`。

- [ ] **Step 2: 跑 RED。**

Run：Task 1 的两个目标文件命令。Expected：判定函数未导出断言失败；exact 删除用旧实现会返回 true 并移走 replacement。修正 fixture 名称或作用域造成的错误后重新观察 RED，不修改产品迎合非法 fixture。

- [ ] **Step 3: 最小实现。** 在新模块实现共同的同步判定；现有 domain 仅重导出两个 export。

```js
const positive = (value) => Number.isSafeInteger(value) && value > 0;

function assess({ messages, readGoal, isLive, active = false }, delivery) {
  const automatic = messages.filter((message) => message.source?.kind === "goal");
  if (automatic.length === 0) return { kind: "allow" };
  const result = (kind, code, error) => ({ kind, code, messages: automatic,
    ...(error === undefined ? {} : { error }) });
  if (automatic.length !== 1) return result("reject", "multiple-goal-inputs");
  const source = automatic[0].source;
  if (typeof source.goalId !== "string" || source.goalId.length === 0
    || !positive(source.revision) || !positive(source.round)) return result("reject", "source-invalid");
  if (active) return result("reject", "unsupported-active-goal-input");
  let goal;
  try {
    if (!isLive()) return result("hold", "lifecycle-ended");
    goal = readGoal();
    if (!isLive()) return result("hold", "lifecycle-ended");
  } catch (error) { return result("hold", "goal-read-failed", error); }
  if (goal === undefined) return result("reject", "goal-missing");
  if (!goal || typeof goal.id !== "string" || !positive(goal.revision)
    || !Number.isSafeInteger(goal.roundsStarted) || goal.roundsStarted < 0
    || !positive(goal.maxGoalRounds) || !["armed", "disarmed"].includes(goal.activation)
    || !["active", "paused", "blocked", "complete"].includes(goal.phase)) {
    return result("hold", "goal-read-failed");
  }
  if (goal.id !== source.goalId || goal.revision !== source.revision) return result("reject", "goal-mismatch");
  if (goal.phase !== "active") return result("reject", "goal-inactive");
  if (goal.activation !== "armed") return result("reject", "goal-disarmed");
  if (source.round > goal.maxGoalRounds) return result("reject", "round-limit");
  const expected = delivery ? goal.roundsStarted : goal.roundsStarted + 1;
  if (!Number.isSafeInteger(expected) || source.round !== expected) return result("reject", "round-mismatch");
  return { kind: "allow" };
}
export const assessGoalAdmission = (options) => assess(options, false);
export const assessGoalDelivery = (options) => assess(options, true);
```

`readGoal` 不存在须由 Agent adapter 同步抛错，不通过可选链把 missing service 变成无目标。读取 Promise 被上述 view 校验暂挂，不能等待它并放宽同步接口。

将 `DshInbox.remove` 改为：

```js
remove(messageId, expectedMessage) {
  const at = this.#locate(messageId);
  if (at === undefined || (expectedMessage !== undefined
    && this.#state[at.target][at.index] !== expectedMessage)) return false;
  this.splice(at.target, at.index, 1, []);
  return true;
}
```

- [ ] **Step 4: GREEN 与整套回归。**

Run：两个目标文件，再 `pnpm test`。Expected：所有新判定/删除测试通过，原工具权限、MCP/mod/bridge 回归无新增失败。记录结果；不 commit。

### Task 2: 重建原生登记证据，不新增 sent 状态

**Files:**
- Create: `lib/input-registration.mjs`, `test/input-registration.test.mjs`。
- Modify: `lib/run-input.mjs`（仅重导出）。

**Interfaces:**
- Consumes: `pluginFacts(session).events(): Event[]`，其中 native event 有 `seq`，private record 有 `factSeq, afterSeq, anchorHash`，`claude-code/input` 的 reserved data 有完整 `message`。
- Produces: `inspectInputRegistration(session, message): { kind: "unregistered" } | { kind: "registered", event: NativeEvent }`。证据冲突/读失败抛错，不返回 unregistered。
- Produces: `registerInputMessage(session, message): NativeEvent`。无原登记才 append `user/message`；已登记直接返回原事件。不是投递授权，不改变 ledger 状态。
- 所有记录读取失败都向上传播；不使用 `readSessionEvents` 的吞错空数组，不使用只有最新 entry 的 `recoverableInputs` 来证明未登记。

- [ ] **Step 1: 写失败测试。** 从现有 run-input namespace 获取新接口，保留真实 ledger 与 attachFacts；通过显式 assert 缺失接口制造 RED。

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as input from "../lib/run-input.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";

const message = { id: "u1", role: "user", source: { kind: "user" },
  content: [{ type: "text", text: "same input" }] };
function fixture() {
  const events = [];
  return attachFacts({ id: "registration-unit", header: { cwd: "/w" },
    append(type, data) {
      const event = { seq: events.length, time: Date.now(), type, data: structuredClone(data) };
      events.push(event); return event;
    }, snapshotEvents: () => [...events] });
}
function reserve(session, epoch = "old") {
  new input.RunInputLedger(session, epoch).record(message.id, "reserved", {
    message, queue: "next-turn", position: 0, querying: true,
  });
}
function register(session, value = message) {
  assert.equal(typeof input.registerInputMessage, "function");
  return input.registerInputMessage(session, value);
}
test("registered 不是 submitted，重新登记返回唯一原事件", () => {
  const session = fixture(); reserve(session);
  const first = register(session);
  const second = register(session);
  assert.equal(second.seq, first.seq);
  assert.equal(session.snapshotEvents().filter((e) => e.type === "user/message").length, 1);
  assert.equal(new input.RunInputLedger(session, "old").stateOf(message.id), "reserved");
});
test("新 epoch 锚点跨过原事件仍保留早期登记证明", () => {
  const session = fixture(); reserve(session);
  const first = register(session);
  reserve(session, "new");
  assert.equal(register(session).seq, first.seq);
  assert.equal(session.snapshotEvents().filter((e) => e.type === "user/message").length, 1);
});
test("native append 后下一次 sidecar 拒写仍可发现原登记", () => {
  const session = fixture(); reserve(session);
  const first = register(session);
  session.rejectFact = () => { throw new Error("disk rejected"); };
  assert.throws(() => new input.RunInputLedger(session, "old").submitBatch(["u1"], {}), /disk rejected/);
  assert.equal(typeof input.inspectInputRegistration, "function");
  assert.equal(input.inspectInputRegistration(session, message).event.seq, first.seq);
});
for (const kind of ["duplicate", "payload", "source", "missing-anchor"]) {
  test(`登记证据 ${kind} fail closed`, () => {
    const session = fixture();
    if (kind !== "missing-anchor") reserve(session);
    session.append("user/message", message);
    if (kind === "duplicate") session.append("user/message", message);
    const candidate = kind === "payload" ? { ...message, content: [{ type: "text", text: "changed" }] }
      : kind === "source" ? { ...message, source: { kind: "system" } } : message;
    const before = session.snapshotEvents().length;
    assert.throws(() => register(session, candidate), /input-registration/);
    assert.equal(session.snapshotEvents().length, before);
  });
}
test("读取错误不被当成未登记", () => {
  const session = fixture(); reserve(session);
  session.snapshotEvents = () => { throw new Error("unreadable native log"); };
  assert.throws(() => register(session), /unreadable native log/);
});
```

再增加 anchorHash 被篡改、同 id 原事件存在但唯一 reserved 在其后、无提交证据恢复保留 queue/position/querying、submitted/uncertain 不恢复的测试。锚点破坏用 `session.factRecords` 的副本创建新的 attachFacts session；不能直接修改已冻结记录来假称恢复校验生效。

- [ ] **Step 2: 跑 RED。**

Run：`node --test --experimental-test-module-mocks test/input-registration.test.mjs test/run-input.test.mjs test/plugin-facts.test.mjs`。
Expected：新接口断言失败；既有台账测试建立未改变的基线。若既有失败，按名称报告并分析，不忽略。

- [ ] **Step 3: 最小实现。**

```js
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
```

重导出：`export { inspectInputRegistration, registerInputMessage } from "./input-registration.mjs";`。完整 private 记录的锚点/hash 验证仍交给 `PluginFacts.events()`，不复制 hash 实现、不使用最新 reservation 锚点替代历史。无原事件不等于已获 goal/投递授权：所有调用者必须先持久 reserved，再走 Agent gate。

不添加 registered private fact 来独自证明登记，不新增 native 事件，不再次 `record(id, "reserved", { nativeUserSeq })` 补元数据——现有同状态 record 是 no-op。

- [ ] **Step 4: GREEN 与整套回归。**

Run：目标文件及 `pnpm test`。Expected：原登记只出现一次；sidecar 失败后读证据不伪造 submitted；所有既有恢复/receipt 测试通过。记录完整结果，不提交。

### Task 3: 初始 drive、暂挂、同步重入和 claim 恢复

**Files:**
- Create: `test/helpers/goal-fixture.mjs`。
- Modify: `lib/agent.mjs` 初始 drive/send/finally、`test/agent.test.mjs`。

**Interfaces:**
- Consumes: Task 1 两个判定函数与 `remove(id, expected)`；Task 2 `inspectInputRegistration` / `registerInputMessage`；现有 `RunInputLedger.record(id,state,detail)`。
- Produces Agent 内部接缝：`selectInput(target?): { target, messages } | undefined`；`applyGoalDecision(decision, stage): boolean`；`checkGoal(messages, phase, active = false, delivery = false): Decision`；`recoverInputs(): void`。
- Produces `heldGoalInputs: Map<UserMessage, { code: string, error?: unknown }>`（process-local 调度暂挂，不是 goal authority）。暂挂只针对 exact 对象；replacement 不继承旧拒绝。
- Produces `wireGoalFixture(ctx, getAgent): state`；state 为 `{ view, error, reads, onNativeEvent(event) }`，view 初始为 active/armed g1 revision1 roundsStarted0 maxGoalRounds3。仅测试使用。

- [ ] **Step 1: 补合法 fixture 与首个失败测试。** 修改 `driveOneTurn` 的默认消息加入稳定非空 id；现有 goal 测试同样补 id。fixture 的 registry `get(id)` 必须返回 exact agent；无 goal 输入不能靠关闭守卫通过。

新 fixture 的核心：

```js
export function wireGoalFixture(ctx, getAgent) {
  const state = { view: { id: "g1", revision: 1, phase: "active", activation: "armed",
    roundsStarted: 0, maxGoalRounds: 3 }, error: undefined, reads: 0,
    onNativeEvent(event) {
      const source = event.data?.source;
      if (event.type === "user/message" && source?.kind === "goal") {
        if (source.goalId !== state.view?.id || source.revision !== state.view.revision
          || source.round !== state.view.roundsStarted + 1) throw new Error("fixture: invalid native goal admission");
        state.view.roundsStarted = source.round;
      }
    } };
  ctx.provide("agents", { get: (id) => getAgent()?.id === id ? getAgent() : undefined,
    withInitiator: async (_agent, fn) => fn() });
  ctx.provide("goals", { get(agent) {
    if (agent !== getAgent()) throw new Error("fixture: not live");
    state.reads += 1;
    if (state.error) throw state.error;
    return state.view === undefined ? undefined : structuredClone(state.view);
  } });
  return state;
}
```

`fakeSession(timeline, onNativeEvent = () => {})` 在推入 native event 后同步调用 onNativeEvent，测试可再包一层追加监听器。`driveOneTurn` 使用先声明 agent、wire fixture、创建 session、构造 agent 的次序；返回 `{ session, timeline, agent, goal }`。不把 fixture 计数更新放在 read/claim/receipt 中。

在同文件增加以下 helper；原 dispatch 对象只换方法、不换对象，确保 inbox 持有的 dispatch 也能触发 onClaim。

```js
import { wireGoalFixture } from "./helpers/goal-fixture.mjs";

async function driveBatch(entries, { view, attachments, onNativeEvent, onClaim, onCreated } = {}) {
  const timeline = [];
  const ctx = new Context();
  let agent;
  const goal = wireGoalFixture(ctx, () => agent);
  if (view !== undefined) goal.view = structuredClone(view);
  if (attachments) ctx.provide("attachments", attachments);
  const session = fakeSession(timeline, (event) => {
    goal.onNativeEvent(event);
    onNativeEvent?.(event, { goal, agent });
  });
  agent = new ClaudeCodeAgent(ctx, "agent-1", {}, session, { traceSubagents: false });
  Object.assign(agent.dispatch, fakeDispatch(timeline));
  agent.dispatch.emit = (name, payload) => {
    timeline.push(`dispatch:${name}`);
    if (name === "agent/inbox/claimed") onClaim?.(payload, { goal, agent });
  };
  for (const entry of entries) agent.inbox.enqueue(entry.target, entry.message, entry.querying);
  onCreated?.({ goal, agent, session });
  agent.wakeDriver();
  await agent.whenIdle();
  return { session, timeline, agent, goal };
}
```

`resolveHook` 的 mock 实现须保留生产参数：`resolveClaude: async (options) => { await resolveHook?.(options); return { executable: "fake-claude", env: {} }; }`。这只是测试等待接缝，不增加生产构造选项。

关键测试体：

```js
const automatic = { id: "g-auto", role: "user", source: { kind: "goal", goalId: "g1", revision: 1, round: 1 },
  content: [{ type: "text", text: "OLD-GOAL" }] };
const human = { id: "human", role: "user", source: { kind: "user" },
  content: [{ type: "text", text: "HUMAN" }] };
const injected = { id: "context", role: "user", source: { kind: "system" },
  content: [{ type: "text", text: "CONTEXT" }] };

// driveBatch 的 entries 为 { target, message, querying }。
const result = await driveBatch([
  { target: "next-step", message: human, querying: true },
  { target: "next-turn", message: automatic, querying: true },
], { view: { id: "g1", revision: 2, phase: "active", activation: "armed", roundsStarted: 0, maxGoalRounds: 3 } });
assert.equal(result.session.events.some((e) => e.type === "user/message" && e.data.id === automatic.id), false);
assert.equal(runCalls.length, 1);
assert.deepEqual(runCalls[0].initialMessages, [human]);
assert.equal(runCalls[0].prompt.includes("OLD-GOAL"), false);
assert.equal(result.goal.view.roundsStarted, 0);
```

每条测试开始重置 runCalls/runResult。使用 Promise.withResolvers 控制图片/resolveClaude 等待，不使用固定 sleep；mock auth 的 resolveClaude 增加可控 `resolveHook`，默认仍 fake executable。先加入下面两个测试组，钉住异步和同步失效窗口：

```js
for (const mutation of ["edit", "pause", "disarm"]) {
  test(`resolveClaude 等待期间 ${mutation} 不沿用授权`, async () => {
    runCalls = []; runResult = { stopReason: "completed", logIntact: true };
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const created = Promise.withResolvers();
    resolveHook = async () => { entered.resolve(); await release.promise; };
    const run = driveBatch([{ target: "next-turn", message: automatic, querying: true }], {
      onCreated: created.resolve,
    });
    try {
      const { goal } = await created.promise;
      await entered.promise;
      if (mutation === "edit") goal.view.revision += 1;
      if (mutation === "pause") goal.view.phase = "paused";
      if (mutation === "disarm") goal.view.activation = "disarmed";
      release.resolve();
      const { session } = await run;
      assert.equal(session.events.some((e) => e.type === "user/message" && e.data.id === automatic.id), false);
      assert.equal(runCalls.length, 0);
      assert.equal(goal.view.roundsStarted, 0);
    } finally { release.resolve(); resolveHook = undefined; await run; }
  });
}
for (const stage of ["claim", "turn/start", "human-user-message"]) {
  test(`同步 ${stage} 失效保留人类登记且不启动旧批`, async () => {
    runCalls = []; runResult = { stopReason: "completed", logIntact: true };
    const change = ({ goal }) => { goal.view.revision = 2; };
    const { agent, session, goal } = await driveBatch([
      { target: "next-step", message: human, querying: true },
      { target: "next-turn", message: automatic, querying: true },
    ], {
      onClaim: stage === "claim" ? (_payload, state) => change(state) : undefined,
      onNativeEvent: (event, state) => {
        if (stage === "turn/start" && event.type === "turn/start") change(state);
        if (stage === "human-user-message" && event.type === "user/message" && event.data.id === human.id) change(state);
      },
    });
    assert.equal(runCalls.length, 0);
    assert.equal(session.events.filter((e) => e.type === "user/message" && e.data.id === automatic.id).length, 0);
    assert.equal(session.events.filter((e) => e.type === "user/message" && e.data.id === human.id).length, 1);
    assert.equal(goal.view.roundsStarted, 0);
    agent.wakeDriver();
    await agent.whenIdle();
    assert.equal(runCalls.length, 1);
    assert.equal(session.events.filter((e) => e.type === "user/message" && e.data.id === human.id).length, 1);
  });
}
```

以下其余各行各有独立 test，按 `driveBatch` 的明确控制条件构造，不合并成一个无法定位的巨型断言：

| 注入条件 | 精确断言 |
|---|---|
| 合法 goal | 一次 run、一条 native goal、roundsStarted=1 |
| 图片等待后 revision++ / phase=paused / activation=disarmed | 旧 goal native 数=0、run 数=0 |
| resolveClaude 等待后 edit/pause/disarm | 同上；成功读取不能自动 resume |
| 等待期间 remove，或 replace 为同 id 新对象 | 不提交旧 prompt、不删除 replacement；替代合法输入仅提交其新内容 |
| 等待期间新增 steer | 新项不偷渡旧 prepared prompt；它在重新准备或独立 active 提交中出现 |
| 两条 next-step goal + querying human | 两条 goal 全拒绝；human source/content 保留；计数=0 |
| 无效 goal + 非 querying inject | run 数=0、inject 仍 pending、steers 不新增 |
| onClaim 改 revision / abort | 自动 native 数=0、run 数=0；reserved 可恢复，不补旧 goal |
| turn/start 回调改 revision | 同上，已开 turn 合法收尾 |
| 前序 human user/message 回调改 revision | native human 数=1、native goal 数=0、旧批 run 数=0；显式下一次 wake 后 human native 仍=1 |
| goal.get 抛错，队列后面 human followup | 自动仍 pending/暂挂、human 能完成；reads 有限，不发 agent/error 假装用户取消 |
| 同一失败 goal + cancel keepInbox / wakeRequested | whenIdle 可结束；显式 human 前不自动反复读取 |
| 已暂挂对象被同 id replacement 替换 | 新对象不在 heldGoalInputs；旧异步拒绝不会删除它 |
| 日志/ledger 拒写 | run 数=0；不猜登记、不重编号、不补成功 receipt |

- [ ] **Step 2: 跑 RED。**

Run：`node --test --experimental-test-module-mocks test/agent.test.mjs`。
Expected：陈旧 goal 当前会运行或写入、同步重入遗漏与原登记重复的断言失败。读取失败测试先以 Promise barrier 控制次数并主动 abort 旧实现，避免 RED 本身挂死。

- [ ] **Step 3: 实现选择、判定与暂挂接缝。**

`selectInput()` 的选择规则用下列代码实现；保持普通输入相对顺序，仅绕过 held 自动项：

```js
selectInput(target) {
  const steps = this.inbox.nextStep.filter((message) => !this.heldGoalInputs.has(message));
  if (target === "next-step") return steps.length ? { target, messages: steps } : undefined;
  const next = this.inbox.nextTurn.find((message) => !this.heldGoalInputs.has(message));
  if (next) return { target: "next-turn", messages: [...steps, next] };
  return steps.some((message) => this.steers.has(message.id))
    ? { target: "next-step", messages: steps } : undefined;
}
checkGoal(messages, phase, active = false, delivery = false) {
  const check = delivery ? assessGoalDelivery : assessGoalAdmission;
  return check({ messages, active,
    isLive: () => this.phase === phase && !phase.abort.signal.aborted
      && this.loopCtx.agents?.get?.(this.id) === this,
    readGoal: () => {
      if (typeof this.loopCtx.goals?.get !== "function") throw new Error("goal service unavailable");
      return this.loopCtx.goals.get(this);
    } });
}
applyGoalDecision(decision, stage) {
  if (decision.kind === "allow") return true;
  for (const message of decision.messages) {
    if (decision.kind === "hold") this.heldGoalInputs.set(message, {
      code: decision.code, ...(decision.error === undefined ? {} : { error: decision.error }),
    });
    else this.inbox.remove(message.id, message);
  }
  const identity = (value) => typeof value === "string" && value.length <= 256 ? value : undefined;
  const counter = (value) => Number.isSafeInteger(value) && value > 0 ? value : undefined;
  this.loopCtx.logger?.warn?.(`dsh-claude-code: ${JSON.stringify({
    code: decision.code, stage, messageIds: decision.messages.map((m) => identity(m.id)),
    sources: decision.messages.map((m) => ({ goalId: identity(m.source.goalId),
      revision: counter(m.source.revision), round: counter(m.source.round) })),
  })}`);
  return false;
}
```

诊断只序列化合法 string id 与安全整数轮次；非法 source 的任意对象/字符串长度超限不原样复制。保留原 error 于内部 hold，不打印其正文/stack，因为上游错误可能含目标正文。普通拒绝不派发 agent/error，不调用任何 goal mutation。

构造函数初始化 `heldGoalInputs = new Map()`。`send` 中新的 querying 输入成功 enqueue 后清理暂挂，表示一次明确的新输入/宿主投递触发重评估；不以 source=user 为资格过滤，也不授予人类权限。inject 不清理、不唤醒。不因为 get 变为成功而自行计时重试，不增订阅驱动器。对维护任务的明确结束唤醒沿用同一 eligible 判定，不把失败自动项当作可启动输入。

```js
// send：enqueue 成功之后、flush/wake 之前。
if (wakeup) this.heldGoalInputs.clear();
// wakeDriver：保留非 idle 的 wakeRequested 分支；仅在创建 idle→running phase 前加门槛。
if (!this.selectInput()) return;
// runMaintenance：替换原 maintenance.wakeRequested && inbox.hasPending 判断。
if (maintenance.wakeRequested && this.selectInput()) this.wakeDriver();
```

补充维护回归：先使 goal.get 失败而暂挂自动项，再执行 maintenance 并设置 wakeRequested；维护完成后 goal.reads 不增加、无自动 run、whenIdle 结束；随后 querying 的 system source followup 能触发重评估并完成，证明没有 human-only 调度过滤。

恢复时只把旧 hold 映射到本次 recover 新插入、且完整消息 deep-equal 的对象，不能映射到早已 pending 的 replacement：

```js
recoverInputs() {
  const before = new Set([...this.inbox.nextStep, ...this.inbox.nextTurn]);
  const held = [...this.heldGoalInputs];
  this.inbox.recover();
  for (const message of [...this.inbox.nextStep, ...this.inbox.nextTurn]) {
    if (before.has(message)) continue;
    const previous = held.find(([old]) => isDeepStrictEqual(old, message));
    if (previous) this.heldGoalInputs.set(message, previous[1]);
  }
  const pending = new Set([...this.inbox.nextStep, ...this.inbox.nextTurn]);
  for (const old of this.heldGoalInputs.keys()) if (!pending.has(old)) this.heldGoalInputs.delete(old);
}
```

finally 的 recovery 改调该方法；`resumable` 和最终 wake 条件都用 `selectInput() !== undefined`，而不是 hasPending/队列长度。log/证据读写失败时禁止本次 finally 自动重启；保留待办以待显式操作。

- [ ] **Step 4: 接入初始准备、claim 与 user/message 边界。** 按下列顺序改 drive，不在最后同步检查与 reserved/consume 之间加入 await：

```js
const selected = this.selectInput();
if (!selected) break;
const { messages } = selected;
if (!this.applyGoalDecision(this.checkGoal(messages, phase), "before-prepare")) continue;
const prepared = await buildPrompt(this.loopCtx, messages, phase.abort.signal);
const resolved = await this.loopCtx.agents.withInitiator(this, () => resolveClaude({
  ctx: this.loopCtx, config: this.config, signal: phase.abort.signal,
}));
if (phase.abort.signal.aborted || this.phase !== phase) break;
if (!messages.every((m) => this.inbox.nextStep.includes(m) || this.inbox.nextTurn.includes(m))) continue;
if (!this.applyGoalDecision(this.checkGoal(messages, phase), "after-prepare")) continue;
```

重新选批次时丢弃 prepared.prompt/images，不只过滤 initialMessages。然后沿用现有 reserved/consume/turn/start。写入循环改为：

```js
for (const message of messages) {
  if (phase.abort.signal.aborted || this.phase !== phase) throw new Error("input is stopping");
  if (message.source?.kind === "goal") {
    const decision = this.checkGoal([message], phase);
    if (decision.kind !== "allow") {
      // 此处消息已 claim，不再通过 pending remove 猜测取消。
      if (decision.kind === "hold") this.heldGoalInputs.set(message, {
        code: decision.code, ...(decision.error === undefined ? {} : { error: decision.error }),
      });
      else {
        ledger.record(message.id, "canceled");
        this.dispatch.emit("agent/inbox/discarded", { message });
      }
      throw new GoalInputRejected(decision, "before-native-goal");
    }
  }
  registerInputMessage(this.session, message);
}
```

定义内部异常并在现有内层 catch 的 agent/error 分支前分流，保留原非 guard 错误处理：

```js
class GoalInputRejected extends Error {
  constructor(decision, stage) {
    super(`goal input rejected: ${decision.code}`);
    this.decision = decision;
    this.stage = stage;
  }
}

// catch 中 stopAfterTurn=true、确认 turnStarted 后。
if (error instanceof GoalInputRejected) {
  this.applyGoalDecision(error.decision, error.stage);
  try {
    await this.dispatch.serial("agent/turn-stopping", { turn, signal: phase.abort.signal });
    this.session.append("turn/end", { turn, reason: { kind: "error", error: {
      code: "GOAL_INPUT_REJECTED", message: `goal input rejected: ${error.decision.code}`,
    } } });
  } catch {
    // 不继续 query；本次 finally 也不自动重启，保留合法开放 turn。
    phase.inputFailure = true;
  }
} else {
  phase.inputFailure = true;
  // 保留原 agent/error 与 turn/end 尝试，日志写入失败不假造回滚。
  this.dispatch.emit("agent/error", { turn, step: 0, error });
  try {
    this.session.append("turn/end", { turn, reason: { kind: "error", error: {
      message: String(error?.message ?? error), code: "UNKNOWN",
    } } });
  } catch { /* 保留开放 turn；不自动继续。 */ }
}
```

`phase.inputFailure` 为新增的本次运行失败标记，只影响自动调度，不是 goal phase。外层 preparation/registration/recovery 错误以及 result.logIntact=false 也设为 true；最后自唤醒条件增加 `!phase.inputFailure`。ordinary goal rejection 不设该标记，以免顺带永久堵塞可恢复的人类项。成功关闭后可恢复尚未提交的其它输入；claim 的部分 splice 失败不得假设整个 consume 回滚，恢复读取真实事实。

对已经登记的 human，下一次 drive 用 Task 2 原事件，不重复 append。对已登记的 goal，下一次 admission 仍检查 `roundsStarted + 1`，旧 round 不因此获得重投资格；不把 helper 的 registered 当作绕过 admission 的许可证。

- [ ] **Step 5: GREEN 与整套回归。**

Run：`test/agent.test.mjs`，再 `pnpm test`。Expected：完整矩阵通过；fake runner 与 production Agent 证据仅称离线单元/集成，不称真实 CLI 消费或宿主 lifecycle 验收。记录未覆盖的模型/UI 层，不提交。

### Task 4: 运行中过滤、无进度停止与初始 SDK 交付 fence

**Files:**
- Modify: `lib/agent.mjs:197-214,262-294`、`lib/claude-run.mjs` options 与 `1048-1086`、必要的 `lib/run-control.mjs` 布尔接口检查、`test/run-control.test.mjs`。

**Interfaces:**
- Consumes: Task 3 `selectInput("next-step")`、`checkGoal(..., active=true)`、`recoverInputs`；Task 2 原登记 helper。
- Produces runner option `canStartInput?: (batch: UserMessage[]) => boolean`（同步，仅首批已登记后的交付）；缺省保持旧 runner 行为。
- Produces result `initialRejected?: boolean`；普通准入拒绝返回 `initialSubmitted:false, initialRejected:true, stopReason:"error"`，logIntact 反映实际日志，不用 false 冒充日志拒写。
- active `canSubmitInput` 和 `onInputSubmitted` 仍同步，不返回 Promise；active 自动 goal 不走 delivery guard。

- [ ] **Step 1: 写 active 及 false 调度失败测试。** `makeAgent` 改用 Task 3 fixture，并让 session append 调用 goal.onNativeEvent；保留 production runner/controller 与 SDK fake。每个 test 结束清理 fake.finish/await agent.whenIdle，避免泄漏活查询。

在同文件新增：

```js
test("active automatic goal 被剔除后普通 steer 和 inject 重新准备", async () => {
  const { agent, s } = makeAgent();
  agent.followup(message("first"));
  while (!active) await Promise.resolve();
  const fake = active;
  await fake.first;
  try {
    // 在同一同步堆栈 enqueue，显式启动 lane，避免第一项提前单独准备。
    agent.inbox.enqueue("next-step", message("stale-goal", "goal"), false);
    agent.inbox.enqueue("next-step", message("steer"), true);
    agent.inbox.enqueue("next-step", message("context", "system"), false);
    agent.flushInput(agent.activeInput);
    await fake.waitInput(2);
    assert.equal(JSON.stringify(fake.input[1]).includes("stale-goal"), false);
    assert.equal(JSON.stringify(fake.input[1]).includes("steer"), true);
    assert.equal(JSON.stringify(fake.input[1]).includes("context"), true);
    assert.equal(fake.input[1].shouldQuery, true);
    assert.equal(s.events.some((e) => e.type === "user/message" && e.data.id === "stale-goal"), false);
  } finally { fake.finish(); await agent.whenIdle(); }
});

test("submit false 且 pending 不变不会重新 flush", async () => {
  const { agent } = makeAgent();
  const phase = { abort: new AbortController() };
  let submissions = 0;
  const lane = { phase, turn: 1, accepting: true, controller: {
    async submit() {
      submissions += 1;
      // RED 旧实现能确定性结束，不让测试本身挂死。
      if (submissions > 2) phase.abort.abort({ kind: "user" });
      return false;
    },
  } };
  agent.activeInput = lane;
  agent.inbox.enqueue("next-step", message("pending"), true);
  agent.flushInput(lane);
  await lane.flushing;
  await Promise.resolve();
  assert.equal(submissions, 1);
  assert.equal(agent.inbox.nextStep[0].id, "pending");
});
```

增加 receipt/result 权威断言：native 登记或 SDK replay 不提前将 human 加入 currentTurn.messages；匹配 success UUID 才触发 consumed。既有“initial goal + human steer”测试保留且 fixture 合法。

- [ ] **Step 2: 写首批晚失效测试。** 用已有 `start()` 和 SDK onQuery hook，不启动真实模型：

```js
test("初始 canStartInput 拒绝不是日志失败或已交付", async () => {
  let allowed = true;
  onQuery = (fake) => { allowed = false; fake.finish(); };
  const run = start({ canStartInput: () => allowed });
  try {
    // 不等 fake.first：拒绝时本来就不应有第一条输入。
    const result = await run.run;
    await run.fake()?.ended;
    assert.equal(result.initialSubmitted, false);
    assert.equal(result.initialRejected, true);
    assert.equal(result.logIntact, true);
    assert.equal(run.fake()?.input.length ?? 0, 0);
  } finally { onQuery = undefined; run.fake()?.finish(); await run.run; }
});
```

onQuery 同步关闭 fake output，让旧实现的 RED 也能确定性收尾；再等 fake.ended 读取最终输入数，不以 timeout 作结论。另加生产 Agent 的真实登记/交付边界测试：

```js
test("生产 Agent 已登记 goal 在 query 创建期间 disarm，模型输入为零", async () => {
  const { agent, s, goal } = makeAgent();
  const created = Promise.withResolvers();
  onQuery = (fake) => {
    goal.view.activation = "disarmed";
    created.resolve(fake);
    fake.finish();
  };
  try {
    agent.followup(message("late-goal", "goal"));
    const fake = await created.promise;
    await agent.whenIdle();
    await fake.ended;
    assert.equal(fake.input.length, 0);
    assert.equal(s.events.filter((e) => e.type === "user/message" && e.data.id === "late-goal").length, 1);
    assert.equal(goal.view.roundsStarted, 1);
    assert.ok(fake.closes >= 1);
  } finally { onQuery = undefined; active?.finish(); await agent.dispose(); }
});
```

另测 canStartInput 在 query 前已 false（query 调用数=0），fallback 新 query 前 false（无首批输入、旧句柄均关闭），异步 callback 返回 Promise（明确 TypeError，不当 truthy 放行）。对直接 runner 的 Promise case，现有 catch 返回 stopReason:error，其 output 含固定 TypeError message；不错误断言 run.run 一定 rejects。只观察 gate 接缝，不重测真实 mod capability。

继续补覆盖：图片准备期间新 active goal / 同 id replace；取消 old epoch 后 callback 不消费新对象；第二条 active user/message 拒写 / submitted fact 拒写后重建不重写第一条；goal:get 暂挂仅挡自动项不关闭 human lane；filter 后仅 inject 应用 `shouldQuery:false`，在 idle 不建回合。

- [ ] **Step 3: 跑 RED。**

Run：`node --test --experimental-test-module-mocks test/run-control.test.mjs`。
Expected：旧实现交付 active goal、false 调用次数>1、忽略 canStartInput 等断言失败。fixture/清理问题先修正再 RED。

- [ ] **Step 4: 最小实现 active lane。** 在每轮准备前做 active 判定，拒绝 goal 经持久 exact remove 后 fresh select/submit；提交后置的同步 canSubmitInput 再做同一 active 判定。 false 的无进度判断及 finally 防重启必须配套：

```js
let stalled = false;
while (this.activeInput === active && !active.phase.abort.signal.aborted) {
  const selected = this.selectInput("next-step");
  if (!selected) break;
  const messages = selected.messages;
  if (!this.applyGoalDecision(this.checkGoal(messages, active.phase, true), "active-before-prepare")) continue;
  const submitted = await active.controller.submit(messages, {
    shouldQuery: messages.some((message) => this.steers.has(message.id)),
  });
  if (submitted === false) {
    const current = this.selectInput("next-step")?.messages ?? [];
    if (current.length === messages.length && current.every((message, i) => message === messages[i])) {
      stalled = true;
      break;
    }
  }
}
```

`stalled` 放在 flushInput 的 async/catch/finally 共同可见作用域；finally 只有 `!stalled` 且仍 active/accepting/未 abort/有 eligible next-step 时重启。之后新 send 或明确宿主输入可再次调用 flush，不设 timer。false 且快照变化则重新选择，不能沿用旧准备正文。

canSubmitInput 保留现有 phase/currentTurn/exact-membership 检查，增加 abort、`checkGoal(batch, phase, true)`，拒绝时 applyGoalDecision 后同步返回 false。onInputSubmitted 在 consume 前再断言不含 goal（内部一致性防线），consume 后使用 `registerInputMessage` 替代 direct user/message append；同步日志错误仍必须阻止 submitted/channel.push。 ordinary guard 拒绝先在 canSubmitInput 路径处理，不用 onInputSubmitted throw 把它标成 inputLogIntact=false。

- [ ] **Step 5: 最小实现初始交付 fence。** Agent 给 runner 传以下同步 canStartInput；该闭包捕获本次 phase/currentTurn/messages/ledger，不能只按 id 匹配新 epoch。这里比较 `source.round === roundsStarted`，不是重新 admission 下一轮。

```js
canStartInput: (batch) => {
  if (this.phase !== phase || phase.abort.signal.aborted || this.currentTurn !== currentTurn
    || batch.length !== messages.length || !batch.every((message, i) => message === messages[i])) return false;
  for (const message of batch) {
    if (message.source?.kind !== "goal") continue;
    try {
      if (inspectInputRegistration(this.session, message).kind !== "registered") {
        throw new Error("input-registration: initial goal has no native registration");
      }
    } catch (error) {
      phase.inputFailure = true;
      // 原证据错误留在 cause，向输出只给固定错误正文，不复制日志或目标内容。
      throw new Error("input-registration-unavailable", { cause: error });
    }
  }
  const decision = this.checkGoal(batch, phase, false, true);
  if (decision.kind === "allow") return true;
  if (decision.kind === "reject") {
    for (const message of decision.messages) {
      ledger.record(message.id, "canceled");
      this.dispatch.emit("agent/inbox/discarded", { message });
    }
  }
  this.applyGoalDecision(decision, "initial-before-delivery");
  return false;
},
```

若拒绝：原生日志已登记事件保留、roundsStarted 不回滚；cancel ledger 中尚未提交的拒绝 goal，发既有 discarded live 通知并最小诊断。若 goal 读取失败：保留 reserved 并暂挂，恢复 clone 用 recoverInputs 接上。登记证据失败则标记本次 inputFailure，并 fail closed；不能把“读不到证据”当作未登记而再 append。非 goal 的首批继续允许，普通输入不新增目标读取依赖。后续 human 可通过新 drive 提交，不自动重投该旧 round。

runner 在 prepareInitial 后、每次 query 创建前（包括 fallback）、mod handshake 后到 inputControl.start 前调用同步 gate。普通 false 返回正常的拒绝 result，由已有 finally 关闭 input/control/query/modHost；不进入 onReady 或 q 消费循环，不伪报用户取消。最小接缝：

```js
const startAllowed = () => {
  if (!canStartInput) return true;
  const decision = canStartInput(initialMessages);
  if (typeof decision !== "boolean") throw new TypeError("canStartInput must return boolean");
  return decision;
};
const rejectedInitial = () => ({ output: [], stopReason: "error", claudeSessionId,
  logIntact: tracer.logIntact && inputLogIntact,
  initialSubmitted: false, initialRejected: true });

// 在每个实际 query(...) 前，以及 inputControl.start(q, prepared) 前插入：
if (!startAllowed()) return rejectedInitial();
```

不把 query 创建说成输入提交；handshake 期间可能已经有零输入 query，晚拒绝必须关闭它。对 active canSubmitInput 也拒绝非布尔值，不能依赖 JS truthy 处理 Promise。run-control 调用顺序仍为 async prepare → sync canSubmit → reserved → sync onInputSubmitted → 原子 submitted fact → channel.push。

追加 result.initialRejected 处理，避免 initial rejection 通过通用错误路径触发无证据重投。已登记的合法 goal 在交付前变更可能留下一个已合法准入、未交付的 round；这是保留历史的必然后果，验收断言模型输入=0，不宣称轮数能回滚到0。

- [ ] **Step 6: GREEN 与整套回归。**

Run：`test/run-control.test.mjs`，再 `pnpm test`。Expected：首批/active/false/recovery/receipt/epoch 全通过，既有 mod fallback 和 bridge 测试无新增失败。生产 Agent + fake SDK 不是付费 CLI/真实 UI 验收。记录结果，不提交。

### Task 5: 真实 Session 重建、安装版 v4/goal replay 与交付说明

**Files:**
- Modify: `test/session-compatibility.test.mjs`, `README.md`, `README_EN.md`。
- Create: `test/helpers/validate-goal-session.cjs`。
- Artifact only: `.superpowers/sdd/2026-10-14-goal-admission-guard/native/goal-admission-{allowed,rejected,registration-recovery}.json`（本计划独占 scratch，不纳入 git）。

**Interfaces:**
- Consumes: 所有前述生产接口、真实 npm `Session.create(id, events?, header?)`、内存 `attachFacts(session, records)`。
- Produces synthetic artifact `{ header, events, expectedRounds, expectedUserIds }`；只含合成消息，不复制正式日志。
- Validator 消费本计划白名单 artifact；从安装 archive 只读加载 `assertV4RowAdmission`, `assertReleasedV4Relationships`, `KNOWN_SESSION_EVENT_TYPES`, `foldGoal`。

- [ ] **Step 1: 写真实 Session 去重失败测试及合成 artifact。** 使用 attachFacts 的显式内存 storage；先 native 登记，再关闭事实 reader、以相同 events/header/factRecords 新建 Session，避免正式目录。

```js
const first = Session.create("goal-admission-registration-recovery");
attachFacts(first);
const inbox = new DshInbox(first, { emit() {} });
const human = { id: "human", role: "user", source: { kind: "user" },
  content: [{ type: "text", text: "synthetic recovery" }] };
inbox.enqueue("next-turn", human, true);
new RunInputLedger(first, "old").record(human.id, "reserved", {
  message: human, queue: "next-turn", position: 0, querying: true,
});
inbox.consume([human], 1);
first.append("turn/start", { turn: 1 });
registerInputMessage(first, human);
first.append("turn/end", { turn: 1, reason: { kind: "error", error: { code: "SYNTHETIC", message: "before submit" } } });
const events = first.snapshotEvents();
const records = structuredClone(first.factRecords);
first.facts.close();
const reopened = Session.create(first.id, events, first.header);
attachFacts(reopened, records);
const restored = new DshInbox(reopened, { emit() {} });
const recovered = restored.nextTurn[0];
assert.deepEqual(recovered, human);
new RunInputLedger(reopened, "new").record(human.id, "reserved", {
  message: recovered, queue: "next-turn", position: 0, querying: true,
});
restored.consume([recovered], 2);
reopened.append("turn/start", { turn: 2 });
registerInputMessage(reopened, recovered);
reopened.append("turn/end", { turn: 2, reason: { kind: "error", error: { code: "SYNTHETIC", message: "fixture end" } } });
assert.equal(reopened.snapshotEvents().filter((e) => e.type === "user/message").length, 1);
assert.equal(new RunInputLedger(reopened, "new").stateOf(human.id), "reserved");
reopened.facts.close();
```

将新增 imports 明确加入本文件，不靠其它测试模块的 mock。测试 finally 总是关闭绑定 facts。

Artifact 输出仅在设置 `DSH_GOAL_ARTIFACT_DIR` 时开启，路径必须为本计划 native scratch 的 exact resolve 值；`mkdirSync`/`writeFileSync` 只处理该目录。allowed fixture 写一个合法 `goal/change` create 和一个经生产 guard + ledger + registerInputMessage 登记的 round1；rejected fixture 同一 create 后 source round0 经生产 guard + exact remove，被拒绝且不写 user/message；registration-recovery 使用上面真实 Session 重建结果。goal/change 合成数据为：

```js
{ kind: "goal/change", version: 1, operation: "create",
  goal: { id: "g1", revision: 1, objective: "synthetic admission", phase: "active", maxGoalRounds: 3 },
  roundsStarted: 0, createdAt: 100, updatedAt: 100 }
```

allowed 的 expectedRounds=1、expectedUserIds=["g-auto"]；其它 expectedRounds=0，rejected expectedUserIds=[]，recovery expectedUserIds=["human"]。header/events 使用真实 Session 自身生成的数据，不手工伪造 header。

- [ ] **Step 2: 运行目标测试。**

Run：`node --test --experimental-test-module-mocks test/session-compatibility.test.mjs`。
Expected：真实 Session 读写/重建通过；若 Task 2 的去重 helper 被移除/替换为 direct append，本测试必须重复登记失败。此时如新断言已被 Task 2 正确实现而直接 GREEN，记录这是跨层验收，不伪造新的 RED；Task 2 已观察的 RED 仍是该产品改动的测试先行证据。

- [ ] **Step 3: 写安装版离线 validator。** 不复制提取源码为产品运行时依赖。使用已核对安装路径，以 Electron 的 Node 模式只读加载包，不启动宿主 app：

```js
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve, basename } = require("node:path");
const { createRequire } = require("node:module");
const root = resolve(__dirname, "../../.superpowers/sdd/2026-10-14-goal-admission-guard/native");
const names = new Set(["goal-admission-allowed.json", "goal-admission-rejected.json", "goal-admission-registration-recovery.json"]);
const path = resolve(process.argv[2]);
assert.ok(names.has(basename(path)) && path === resolve(root, basename(path)), "synthetic artifact whitelist");
const host = createRequire("C:/software/DeepSeek Harness/resources/app.asar/dsh/node_modules/");
const { KNOWN_SESSION_EVENT_TYPES } = host("@deepseek-ai/dsh-session");
const { assertV4RowAdmission, assertReleasedV4Relationships } = host("@deepseek-ai/dsh-session-format-v3-to-v4");
const { foldGoal } = host("@deepseek-ai/dsh-goal");
const data = JSON.parse(readFileSync(path, "utf8"));
const { header, events, expectedRounds, expectedUserIds } = data;
events.forEach((event, seq) => {
  assert.equal(event.seq, seq);
  assertV4RowAdmission(event, KNOWN_SESSION_EVENT_TYPES);
});
assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES);
assert.equal(foldGoal(events).roundsStarted, expectedRounds);
assert.deepEqual(events.filter((e) => e.type === "user/message").map((e) => e.data.id), expectedUserIds);
const automatic = events.find((e) => e.type === "user/message" && e.data.source?.kind === "goal");
if (automatic) {
  assert.throws(() => foldGoal([...events, { ...automatic, seq: events.length }]), /next admitted round/);
  assert.throws(() => foldGoal([...events, { ...automatic, seq: events.length,
    data: { ...automatic.data, source: { ...automatic.data.source, round: 0 } } }]), /source is invalid/);
}
console.log(JSON.stringify({ artifact: basename(path), events: events.length,
  nativeV4: "passed", goalReplay: "passed", rounds: expectedRounds }));
```

只输出合成 artifact 名称/数量，不输出正文、工具结果或认证资料。negative controls 验证确实调用安装版 strict fold，不能仅通过预期轮数常量称 replay 成功。

- [ ] **Step 4: 生成并验证三个 artifact。**

```bash
DSH_GOAL_ARTIFACT_DIR='C:/Users/Administrator/workplace/project/tools/dsh-claude-code/.superpowers/sdd/2026-10-14-goal-admission-guard/native' node --test --experimental-test-module-mocks test/session-compatibility.test.mjs
for name in allowed rejected registration-recovery; do
  ELECTRON_RUN_AS_NODE=1 'C:/software/DeepSeek Harness/DeepSeek Harness.exe' test/helpers/validate-goal-session.cjs ".superpowers/sdd/2026-10-14-goal-admission-guard/native/goal-admission-$name.json" || exit 1
done
```

Expected：目标测试零失败；三个 artifact 均 nativeV4/goalReplay passed，negative controls 被拒绝。无法启动 Node-mode validator、导出不兼容或 v4 失败必须明确报告该层未通过，不以自写 audit 替代。native durable replay 不检查 process-local armed 或 driver 私有 attempt；不宣称完整生命周期等价。

- [ ] **Step 5: 更新双语交付说明。** 仅增加本功能段落，保留 bridge 既有修改与章节。

中文正文：

> Goal 自动消息在准备前、异步准备后和日志写入口检查宿主公开状态；运行中自动 goal 输入不受支持并在提交前拒绝。普通 followup、steer、inject 及 keepInbox 的原语义保留。读取失败不等于没有目标或自动恢复授权；已提交/不确定输入不自动重投。恢复会核对原生登记证据以避免重复 user/message。这是插件侧有限准入保护，不等价 standard 的私有 reservation/stale/content/fiber fence，不修复历史损坏日志。离线 Session/v4 重放不替代需另行批准的真实 Claude/宿主生命周期验收。

English copy:

> Automatic goal inputs are checked against the host's public state before preparation, after asynchronous preparation, and at the native log boundary. Automatic goal input during an active query is unsupported and rejected before submission. Existing followup, steer, inject, and keepInbox semantics are preserved. A read failure is not an absent goal or renewed continuation authority; submitted or uncertain inputs are never automatically replayed. Recovery checks native registration evidence to avoid duplicate user/message events. This is a limited plugin-side admission guard, not the standard driver's private reservation/stale/content/fiber fence, and it does not repair historical logs. Offline Session/v4 replay does not replace separately approved live Claude or host-lifecycle acceptance.

- [ ] **Step 6: 完整回归、静态验证与最后一次 fresh review。**

Run：`pnpm test`、`git diff --check`、对所有新增 mjs/cjs 执行 `node --check`，并请求 IDE build（仓库未打开而工具不可用时明确记未执行，不把 node --check 当 build）。Expected：完整 suite 零失败、语法/空白无新增问题；installed validator 证据独立记录。

用户选择 Native 后，最终 reviewer 在独立上下文只读审查本计划变更与既有修改的边界，重点检查 Review Focus 五项。没有新收费 CLI 推理或多代理 workflow；review agent 只做代码审查。重要问题由执行者先补 RED 再修复再全套 GREEN；不可用的验证层逐一列明。

不 stage/commit/push，不自动删除本计划账本或 scratch；在没有提交作为恢复证据时保留验证记录。未来清理先看目标并单独授权。

## Spec coverage 与计划自审

| Spec requirement | 计划落点 |
|---|---|
| §1、§3、§4 有限 guard、公开 activation、下一轮、不冒充 private fence | Task 1；header、constraints、Task 5 双语说明 |
| §5 三类判定、无 goal 路径、多个 goal、领域不变 | Task 1 全矩阵；Task 3 adapter |
| §6.1 exact pending 拒绝、querying 决定是否启动 | Task 1 remove；Task 3 selectInput |
| §6.2 async 图片/auth 等待、替换/新增输入、丢弃旧正文 | Task 3 barrier 测试与重新准备；Task 4 active 后置判定 |
| §6.3 synchronous reentry、已登记不重写、未提交恢复、合法收尾 | Task 2 历史证据；Task 3 三种 listener；Task 4 首批晚交付 |
| §6.4 active 自动项无旁路、普通 steer/inject 交付 | Task 4 |
| §7 keepInbox/epoch、非 human-only、暂挂不忙循环且 human 可通过、尊重宿主 pause | Task 3 select/recover/finally；Task 4 lane/receipt |
| §8 最小诊断、无目标与读错误分开、不修正式日志 | Task 1、3；全局边界 |
| §9 suite、真实 Session、安装版原生 v4 与 goal durable replay | Task 5；真实模型/UI 单独授权，不宣称完成 |
| §10 排除项 | 全局约束、文件职责、交付说明 |
| §11 审批顺序 | 本文状态与以下 handoff |

自审结论：Task 1 判定接口与 Task 3/4 调用一致；Task 2 返回原 native event，不产生另一个 sent 状态；Task 3 暂挂恢复映射仅作用于新恢复对象；Task 4 首批 delivery 使用当前已准入轮，不能反过来替代下一轮 admission。五个 Review Focus 均对应明确测试。所有实现/验证步骤仍为未执行 checkbox。

## 执行与交付门槛

1. 本计划文件审阅、执行方式确认后，才调用实施技能、建立本计划账本并开始 RED/GREEN；spec 的批准不代替这一步。
2. 推荐 **Native**：五个任务共享输入协议接缝，当前会话逐任务执行可减少重复调查，最后一次 fresh review 独立检查恢复与权限边界。若用户选 Subagent-driven，再按对应技能设各任务审查门槛；不预先派实施代理。
3. 本计划不要求创建 worktree 或分支；当前 main 上既有未提交修改必须保留。执行技能的通用 worktree/commit 建议不能覆盖用户明确工作区偏好与不提交约束。
4. 交付报告分别列：离线判定/Agent 测试、生产 runner+fake SDK 交付测试、真实 npm Session 重建、安装版 v4/goal replay、未执行的真实模型/UI/宿主生命周期层。
5. 在实际执行前，本文的测试代码、期望结果和验证命令都只是计划，不是已经通过的证据；不宣称 goal 问题或历史 event 9934 已修复。
