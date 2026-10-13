# Claude Code 第一阶段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution or superpowers:subagent-driven-development if the user selects it. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复只读审批误放行、运行中插入/打断和子代理标题，并交付可验证的 mods prompt/goal 适配器。

**Architecture:** DSH 保留业务权威与日志；一个运行控制器拥有查询句柄、可关闭输入流和投递台账。mod 通过受限本机服务观察 prompt、调用共享 goal handler；SDK MCP 是兼容后备。

**Tech Stack:** Node ESM、node:test/module mocks、Claude Agent SDK 0.3.220、DSH 0.2.0-rc.2、Claude CLI function-hook mods。

**Spec:** `docs/superpowers/specs/2026-10-12-claude-code-parity-design.md`

## Global Constraints

- 不修改 DSH app.asar，不安装全局 Claude 插件，不自动 commit/push，不运行未经批准的收费推理。
- 普通 followup 排队；steer 在安全边界插入；inject 不自己启动新的人类回合；显式 cancel 停止当前生成，keepInbox 保留待办。
- mod 未支持时保留 MCP；同一查询不重复暴露 goal 工具。
- 系统提示词快照不冒充最终全文，不向 request/header 写 system。
- 子代理继续保持 one-shot；不伪造用量，不重写历史标题。

## Review Focus

1. 连续提交与取消同时发生：消息应保留/终态清晰，不重放未知消费消息。任务3/4测试。
2. goal 回合收到待处理人类输入：旧工具调用不因排队内容而提权。任务4/5测试。
3. 模块或桥服务失效：安全边界 fail closed，非安全观测错误可见且不损坏主循环。任务1/6/7测试。
4. 中文/控制字符/空描述：列表始终短且可读，不覆盖真实状态。任务2测试。
5. prompt 捕获跨主/子线程或查询重启：不污染另一条会话，不伪造系统 surface 顺序。任务6/7测试。

---

### Task 1: 收紧 read-only 回调

**Files:** Modify `lib/approval.mjs`, `lib/permission.mjs`; Test `test/approval.test.mjs`.

**Interfaces:** 沿用 `makeCanUseTool(ctx,{cwd,session,agent})`，返回 SDK allow/deny；保留 AskUserQuestion 与精确 goal 白名单先行。

- [ ] 添加回归测试，构造 read-only + ask/never，并调用工作区 blockedPath 的 Write，断言不会无审批 allow：
```js
const can = makeCanUseTool(ctx, { cwd: "/work", session: readOnlySession, agent });
const result = await can("Write", { file_path: "/work/a" }, { blockedPath: "/work/a" });
assert.notEqual(result.behavior, "allow");
```
- [ ] 运行 `node --test --experimental-test-module-mocks test/approval.test.mjs`，记录预期失败。
- [ ] mode 与 policy 分开判定；工作区自动允许仅适用于 workspace-write；read-only 对需权限的修改不能用路径短路，never 直接拒绝；ask 经原审批 seam。保留 Full access 的既有交互。
```js
const permission = readPermission(readSessionEvents(session));
if (permission.mode === "workspace-write" && blockedPath && isWithinWorkspace(cwd, blockedPath)) {
  return { behavior: "allow" };
}
```
- [ ] 跑定向测试并覆盖区外路径、无服务、修改中模式切换、AskUserQuestion。更新文档声明：回调修正不等于 OS 沙箱。

### Task 2: 子代理短标签与合法标题

**Files:** Create `lib/subagent-label.mjs`; Modify `lib/subagents.mjs`; Test `test/subagents.test.mjs`, `test/subagent-label.test.mjs`.

**Interfaces:** `subagentDisplay(input) -> {label,title}`；描述来源为 description -> subagent_type -> name -> "子代理"；title 为简短 Claude 来源/类型，不重复整段任务。

- [ ] 写失败测试覆盖空字符串、中文、换行、OSC/CSI、Unicode 截断：
```js
assert.equal(subagentDisplay({ description: "  分析\n工具体系  " }).label, "分析 工具体系");
assert.equal(subagentDisplay({ description: " ", subagent_type: "Explore" }).label, "Explore");
assert.ok(!subagentDisplay({ description: "\x1b[31m任务\x1b[0m" }).label.includes("\x1b"));
```
- [ ] 运行 `node --test test/subagent-label.test.mjs`，确认因缺导出失败。
- [ ] 实现纯清洗与 Unicode 安全截断，#createChild 接收 display；在发布前追加合法标题事实：
```js
session.append("session/title", {
  title: display.title,
  messageSeqs: [],
  source: { kind: "provider", provider: "claude-code" },
});
```
- [ ] 确认 descriptor/catalog 仍 one-shot，标题在持久化 create/append/announce 前保存；不得改变 carrier 或已有 user 标题。运行 label 与 subagents 全部定向测试。

### Task 3: 可关闭输入流与持久化投递台账

**Files:** Create `lib/run-input.mjs`; Modify `lib/inbox.mjs`; Test `test/run-input.test.mjs`, `test/inbox.test.mjs`.

**Interfaces:**
- `RunInputChannel`：`push(SDKUserMessage)`, `close()`, `[Symbol.asyncIterator]()`；关闭后拒绝 push，读者全部退出。
- `RunInputLedger(session,epoch)`：`record(id,state,detail?)`, `stateOf(id)`, `pending()`；事实为专有 `claude-code/input` 事件，绑定 epoch，重建仅看同一会话事件。
- 队列新增 non-destructive 读取/指定 id 消费，不用先整批 claim 再构造图片。

- [ ] 写 channel 的确定性测试：
```js
const channel = new RunInputChannel();
const read = channel[Symbol.asyncIterator]().next();
channel.push({ type: "user", uuid: "u1" });
assert.equal((await read).value.uuid, "u1");
channel.close();
assert.deepEqual(await channel[Symbol.asyncIterator]().next(), { done: true, value: undefined });
assert.throws(() => channel.push({ type: "user" }));
```
- [ ] 测试台账 submitted->uncertain 重建后不得作为 pending 自动重发；构造失败 reserved 退回 pending；重复 id 不重复投递。测试指定消费不吃掉后来追加的 next-step。
- [ ] 运行 `node --test test/run-input.test.mjs test/inbox.test.mjs`，确认失败。
- [ ] 实现最小流与事件折叠，串行日志先行；只有可证明未提交的失败才恢复 pending，submitted 超时标 uncertain。
- [ ] 同命令验证，覆盖多个等待者、close 幂等、append 拒写不变更内存状态。

### Task 4: 驱动接线与显式 interrupt

**Files:** Modify `lib/agent.mjs`, `lib/claude-run.mjs`, `lib/attachments.mjs`; Test `test/agent.test.mjs`, `test/claude-run.test.mjs`; Create `test/run-control.test.mjs`.

**Interfaces:** runClaudeCode 增加受控 `onReady(controller)` 与输入事件回调；controller 仅提供 `submit(messages,{shouldQuery})`, `interrupt()`, `close()`，绑定 epoch，不暴露任意 SDK 方法。已有返回 stopReason/logIntact 保持兼容。

- [ ] fake query 用确定性屏障测试 steer 在当前运行被接收，而 followup 不进入当前 query；inject 不触发新助手；图片输入仍通过 buildPrompt。
```js
await ready.promise;
agent.steer(humanMessage);
await submitted.promise;
assert.equal(calls[0].uuid, humanMessage.id);
assert.equal(calls.length, 1);
```
- [ ] 写中断测试：interrupt 返回 still_queued、不返回 receipt、抛错、旧 epoch、启动前取消、dispose；keepInbox 与新输入唤醒分别断言。
- [ ] 写 authority 测试：排队/提交但未确认消费的 human steer 不改变当前 goal turnContext；来源沿用原 message.source，绝不从工具参数取得。
- [ ] 定向运行带 module mocks 的 agent/run-control/claude-run 测试，确认失败。
- [ ] query 改用真正可持续的 async 输入流并将活 controller 接给 agent；steer 通过串行输入 lane 处理，followup 保持 next-turn；inject 是不触发查询的输入。SDK user 回显/可信 receipt 只核对本地 uuid，忽略未知来源；不能证明消费则不提升 authority。
- [ ] 显式 cancel 优先 interrupt；dispose/abort fallback 关闭，清理监听器及通道。根据任务状态/台账/结果终态关闭，不在首 result 结束整个run。SDK error subtype 返回 error 而非 completed。
- [ ] 保留 tracer 工具配对、取消前缀与 logIntact；验证日志拒写时停止后续未记录投递。运行第一期所有已有回归。

### Task 5: 共享 goal 领域处理器

**Files:** Create `lib/goal-domain.mjs`; Modify `lib/goal-bridge.mjs`; Test `test/goal-bridge.test.mjs`, `test/goal-run.test.mjs`.

**Interfaces:** `buildGoalHandlers({ctx,agent,turnContext,config}) -> undefined | {get_goal(args),create_goal(args),update_goal(args)}`，返回既有 MCP content/isError；`goalToolDefinitions()` 返回准确 JSON schema 供 mod 使用。MCP adapter 保持 buildGoalServer 和原工具名前缀。

- [ ] 新增测试，同样有效/无效输入经 domain 与 MCP handler 的结果相同；包含 CAS、live agent、paused goal、不允许模型恢复、blocked 阈值。
```js
assert.deepEqual(await handlers.get_goal({}), await mcpHandlers.get_goal({}));
assert.equal((await handlers.create_goal({ objective: "task" })).isError, true);
```
- [ ] 跑 goal 定向测试确认失败。
- [ ] 将现有 get/create/update 函数体与权威校验原样移入 domain；MCP 仅包装定义；严格校验 mod 输入，不允许 args 自报人类 source。
- [ ] 跑所有 goal 测试验证无语义改变；领域错误仍转成模型可读 isError，而不是抛断主查询。

### Task 6: 受限本机桥与 prompt snapshot

**Files:** Create `lib/mod-host.mjs`, `lib/prompt-snapshot.mjs`; Test `test/mod-host.test.mjs`, `test/prompt-snapshot.test.mjs`.

**Interfaces:** `createModHost({session,agent,epoch,goalHandlers,onPrompt,signal}) -> Promise<{url,token,close}>`；仅支持 handshake、prompt_snapshot、准确 goal 方法。`validatePromptSections(value)` 严格返回 sections 或抛错；不接受 assistant 文本。

- [ ] HTTP 回归测试覆盖错误 token、会话/epoch、跨子代理、未知方法、超大/坏JSON请求、超时/关闭、重放requestId。同 requestId 工具结果不能重复执行。
```js
const denied = await fetch(host.url, { method: "POST", body: JSON.stringify({ method: "arbitrary" }) });
assert.equal(denied.status, 401);
```
- [ ] prompt 测试拒绝共享节排在会话节之后、重复/空 id、非字符串正文；快照记录来源 observed-compose，重复同正文不膨胀日志，不写 header.system。
- [ ] 运行 host/snapshot 测试确认失败。
- [ ] 使用 Node http loopback、随机 token、恒时比较、大小预算和取消；每一方法内部再核对 live agent/epoch。所有效果先通过 session.append，失败不可回答成功。
- [ ] 保存 `claude-code/prompt-snapshot` 专有事件；原生 system/message 只有首step/user提交同步验证通过后才启用，否则保持快照标识。运行定向测试与 v4 验证用例。

### Task 7: mod 实现、能力验证与包装

**Files:** Create `mods/dsh-bridge/.claude-plugin/plugin.json`, `mods/dsh-bridge/hooks/hooks.json`, `mods/dsh-bridge/hooks/bridge.mjs`, mod 的 `*.test.ts`; Modify `lib/claude-run.mjs`, `index.mjs`, `package.json`; Test `test/mod-options.test.mjs`.

**Interfaces:** mod `register(on,options)`；session.start 做 host handshake；prompt.compose 传回 next(e) 的 sections 原样；tool.register 只注册 domain 定义，tool.call 经 host 请求。配置 `mods.enabled` 与 `goal.transport`(mcp/mod/auto)，默认 MCP 兼容，mod 捕获按能力启用。

- [ ] 模块测试验证捕获不改变 sections，桥断开时 goal 返回错误/deny，tool名准确，无 Node import/动态import；不把 token/url 写日志。
- [ ] 运行 `claude plugin validate <mod目录>` 和 `claude plugin test <mod目录>`；这两项不调用收费模型。未支持CLI记录明确结果，不悄悄忽略。
- [ ] 用本机声明里的 `$` net/tool/prompt 函数实现 mod，不猜 API。SDK options 在启动前选择 adapter，合并既有 env/plugin配置，不污染全局。
- [ ] 给 role/source 信任边界、transport 单选、防重复工具、老CLI回退添加 module-mock 回归。
- [ ] native system prompt 的完整性/顺序通过测试则投影；否则实现明确 observed-compose 快照，文档说明不能当最终完整正文。

### Task 8: 全量回归、文档与独立审查

**Files:** Modify `README.md`, `README_EN.md`, `docs/reference/config.md`, `docs/reference/event-mapping.md`；新增行为与mods使用指南。

- [ ] 更新功能/限制说明：标准交互语义、一次性子代理、真实累计用量、mods适配条件、MCP后备、prompt快照来源、审批与OS沙箱差异。
- [ ] 运行 `pnpm test`；记录实际用例数及失败，不用旧 README 数字代替执行结果。
- [ ] 使用现有 host validator 验证新日志序列，覆盖首prompt/后续steer/interrupt/后台通知/恢复。
- [ ] 运行 `git diff --check`、检查 npm 打包包含mod目录且无token/临时文件；只读审查非插件standard路由仍委托原工厂。
- [ ] 独立代码审查后修复确认问题，重跑受影响测试。真实桌面/模型验证先征得具体预算授权；未执行部分如实报告。
- [ ] 不提交；交付改动、验证结果、明确后续第二/三期范围及未通过兼容性门槛。

## 自检

第一期spec的输入、权限、列表、mods、prompt与goal都有任务；第二/三期不冒充已交付。跨任务接口上方已列出，具体API以本机SDK/mod声明为准。所有Review Focus都有指定失败测试。批准后优先native顺序实施，降低查询/日志状态接口冲突，最后独立审查。
