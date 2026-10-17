# Native Compact Mod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Claude Code agent 的 `/compact` 在独占维护窗口内压缩真实 CLI 上下文，不制造额外用户输入或 DSH surface compaction。

**Architecture:** 复用本包 Mod 与 `runMaintenance`，加入主循环与维护相互隔离的一次性操作协议。新命令只替换 Claude Code 预设的命令提供者，按实际 agent 能力分流；无能力、取消或结果不确定时明确失败。

**Tech Stack:** Node.js ESM、Node test/module mocks、Zod 4、Claude Agent SDK 0.3.220、Claude Code Mods、Cordis scoped commands。

**Spec:** `docs/superpowers/specs/2026-10-16-native-compact-mod-design.md`

## Global Constraints

- 不改宿主源码或全局 compaction 服务；不新增自动压缩、不接通整个 `agent/pre-step`。
- 不放宽 DSH 工具白名单；不搬迁 Goal 权威/持久化；不新增原生 UI。
- 维护总等待默认上限为 5 分钟。
- 不发送伪造的用户消息；不自动重试 uncertain 操作；不续写尚未物化的 fork 父会话。
- 真实摘要涉及模型费用；未获单独预算授权，不运行付费验收。
- 用户已通过本会话 goal 明确要求继续实现 P1–P3，不在每个阶段重复等待执行许可。采用当前会话 native 执行；不创建 worktree、不提交或推送。

## Review Focus

- 路由关闭或覆盖时，真正原生 agent 必须保留原生 compact，而不支持 Mods 的 Claude agent 不得偷换实现。
- 领取许可后进程退出或结果丢失必须 uncertain，重试领取不得再执行副作用。
- 维护期间 followup/steer/inject 保留输入，取消后必须先停止 query 再释放维护锁。
- resume 必须对应当前会话自己的 Claude 历史，不能误用未物化 fork 父 ID。
- CLI 在零输入 resume 的 startup 阶段是否已加载历史必须实测；mock 不能替代运行时门槛。

---

### Task 1: 一次性维护操作与严格桥协议

**Files:**
- Create: `lib/native-operation.mjs`
- Modify: `lib/mod-host.mjs`
- Create: `test/native-operation.test.mjs`
- Modify: `test/mod-host.test.mjs`

**Interfaces:**
- Consumes: `record(data)` 同步私有事实写入器；写入失败抛错。
- Produces: `createNativeOperation({ id, action, params, claudeSessionId, record })`，返回 `{ id, action, params, claudeSessionId, result, claim(), complete(payload), fail(reason), claimed }`。
- `createModHost` 可选接收 `maintenance: { operation, isLive }`；返回原有 `{url,token,ready,close}`。维护模式仅支持 `handshake/maintenance_claim/maintenance_complete`，普通模式原有授权不变。

- [ ] 写失败测试并运行：

```js
const records = [];
const op = createNativeOperation({ id: 'op', action: 'compact', params: {}, claudeSessionId: 'c1', record: x => records.push(x) });
assert.equal(op.claim().execute, true);
assert.equal(op.claim().execute, false);
op.complete({ status: 'succeeded', messageCount: 1, tokensBefore: 100, tokensAfter: 30 });
assert.equal((await op.result).status, 'succeeded');
assert.deepEqual(records.map(x => x.state), ['pending', 'claimed', 'succeeded']);
```

Run: `node --test test/native-operation.test.mjs test/mod-host.test.mjs`，先确认新导出/行为缺失导致 RED。

- [ ] 最小实现严格 action/result schema、领取前持久化、终态重放、claimed→uncertain 和请求身份校验。维护的 `isLive()` 必须显式提供；不得把普通 `live()` 放宽到 idle。
- [ ] 添加跨模式、错 Claude ID、子代理、过期租约、同 request ID 异参、持久化失败测试；普通 goal/prompt 测试不变后 GREEN。

### Task 2: Mod 维护执行与零模型兼容性门槛

**Files:**
- Modify: `mods/dsh-bridge/hooks/bridge.mjs`
- Modify: `mods/dsh-bridge/hooks/bridge.test.ts`
- Create: `test/native-startup-probe.mjs`（手动运行的无模型兼容性探针，不匹配 `.test.mjs`）

**Interfaces:**
- Consumes: handshake 的 `maintenance: { operationId, action, params }`；`maintenance_claim` 返回 `{ execute, action, params }`。
- Produces: 只执行一次操作，向 `maintenance_complete` 返回 `{ operationId, result }`；维护模式不注册 goal 工具、不捕获 prompt。

- [ ] 用原生 Mod 测试写 RED：

```ts
on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary' }], tokensBefore: 100, tokensAfter: 30 }));
// fixture 的握手只广告一次 compact 维护操作；推进 timer 后断言调用一次、回报统计、不携带正文。
expect(calls.filter(x => x.method === 'maintenance_complete').length).toBe(1);
expect(registered).toEqual([]);
```

- [ ] 在会话初始化完成后调度维护执行，领取成功后再调用 `$.session.compact()`；把 `skip`、失败和缺失统计原样区分；catch 只回报脱敏失败，不能吞为成功。
- [ ] 原生测试覆盖重复启动/重载、skip、异常、空历史、错 action；使用实际 CLI `plugin validate` / `plugin test` 验证，不调用推理模型。
- [ ] 编写并执行独立 probe：只在新建隔离目录内创建 fixture transcript/plugin；恢复 fixture 后在 compact hook 截止 native summarizer，记录是否已读到历史、是否零输入进入 compact；强制阻断 `turn.step/model.complete`，不使用用户 profile、不调用收费摘要。若门槛失败，记录证据并修正执行时序，不使用假用户 prompt 绕过。

### Task 3: 专用控制 query 与 Agent 维护入口

**Files:**
- Create: `lib/native-maintenance.mjs`
- Modify: `lib/agent.mjs`
- Modify: `lib/plugin-facts.mjs`
- Create: `test/native-maintenance.test.mjs`
- Modify: `test/agent.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 operation 与维护 mod-host；现有 `resolveClaude`、`probeModSupport/buildModOptions`。
- Produces: `runNativeMaintenance({ ctx, agent, session, config, executable, env, claudeSessionId, signal, commandId, action, params, isLive })`，返回可信终态；拒绝未取得操作结果的流结束。
- `ClaudeCodeAgent.compactNative({ signal, commandId })` 同步取得 `runMaintenance`，解析本会话 ID 后调用 runner；不启动普通 turn/tracer。

- [ ] 写 RED：stub SDK `query` 捕获 async prompt iterator，确认 `resume === 'c1'` 且从未收到用户输入；用 loopback 协议完成操作，断言关闭 query/bridge 和终态事实。
- [ ] 新增私有事实 `claude-code/native-operation`，保留事实 fsync/anchor 约束。构造零投递通道、独立 timeout/abort signal，持续消费 SDK 消息直到操作和 query 安全结束。
- [ ] 操作完成后关闭输入并排空 query；异常先取消、关闭、等待 SDK iterator 结束，再释放维护租约。进程退出但未完成不能成功。
- [ ] 覆盖 busy、无历史、persistSession false、未物化 fork、维护中 queued input、取消/销毁、超时、审计失败、错误 session ID。确认无 user/message/turn/step 伪造记录。

### Task 4: Scoped 命令、打包与回归

**Files:**
- Create: `lib/command-compact.mjs`
- Modify: `package.json`
- Modify: `cordis.patch.yml`
- Create: `test/command-compact.test.mjs`
- Modify: `test/cordis.patch.test.mjs`
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `docs/superpowers/specs/2026-10-13-claude-compaction-design.md`

**Interfaces:**
- Consumes: invocation 的 `agent/signal/commandId/rawInput`；`compactNative` 或真正原生 agent 的宿主 compaction。
- Produces: `apply(ctx)` 注册唯一 scoped `/compact`，输出真实 `CommandResult`；包 export `dsh-claude-code/command-compact`。

- [ ] 写 RED：

```js
assert.equal((await handler({ rawInput: 'unexpected', agent, signal, commandId: 'cmd' })).kind, 'error');
assert.equal((await handler({ rawInput: '', agent: claudeWithoutMods, signal, commandId: 'cmd' })).kind, 'error');
assert.equal(nativeCompactionCalls, 0);
```

- [ ] 对照实际安装宿主命令接口注册模块，追踪 handler promises 在卸载时 drain；只替换本预设 command-compact 行。真正原生 agent 可委托宿主，Claude agent 禁止 fallback。
- [ ] 覆盖 scoped 不重名、native fallback、skip/uncertain/失败文案、无伪造 sourceEventSeq；语法/完整 Node 测试、Mod validate/test、打包 dry-run、diff 检查。
- [ ] 更新支持条件与证据，保留旧调查的历史范围。付费真实压缩未执行时明确标注，不宣称实机成功。

## 后续执行衔接

P1.1 的离线实现与兼容性证据完成后，继续为 P1 Plan/tool bridge、P2 observations/catalog 与 P3 step routing 创建各自 focused plan 并实施。所有阶段共用已建立的认证、主/子归属、失败关闭和无假事件约束，不把接口可用说成已通过付费验收。
