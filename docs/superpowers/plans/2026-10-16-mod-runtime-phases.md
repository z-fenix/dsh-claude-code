# Mod Runtime Phases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 P1 Plan/工具边界、P2 观察/目录/审计工具动态 transport 和 P3 主循环实时模型选择。

**Architecture:** 固定 runtime RPC 表与现有 normal bridge 共用认证，新增小型 host plan/tool/metadata 模块和一个 Mod runtime hooks 模块。SDK 转发独占 transcript；人类命令复用现有维护/输入通道。

**Tech Stack:** Node ESM/test、Zod 4、Cordis、Claude Agent SDK 0.3.220、CLI Mods 2.1.301 当前接口。

**Spec:** `docs/superpowers/specs/2026-10-16-mod-runtime-phases-design.md`

## Global Constraints

- 不开放任意 DSH 工具，不修改宿主，不派发整个 `agent/pre-step`。
- 保留 canUseTool + SDK PreToolUse 的既有双入口只读策略。
- 子 step 只观察，不改变主模式；MCP/DSH 工具不重复进入原生 gate。
- 元数据 summary 本地估算；不默认 full/token-count API。
- 真实付费生成、摘要和正式桌面/v4 生命周期验收未授权，不运行或宣称通过。
- 用户 goal 要求连续执行 P1–P3；当前 feature branch 原地执行，不新建 worktree、不提交/推送。

## Review Focus

- pending:false 是退出目标，不是“没有 pending”；读取失败不能被视为 inactive。
- Full access 下 ExitPlanMode 仍需真实 plan-review，旧/变更文件、错 tool-use ID 不能继承许可。
- Mod 与 canUseTool 对同次文件调用只派发一次 host gate，且重写参数不能改变身份。
- 子 spawn 观察早于 SDK 投影时保持 unknown，再绑定，不写两份子轨迹或借父权限。
- 用户改模型只影响后续主 step，不能重置 CLI fallback 或改子代理模型。

---

### Task 1: Host Plan and native tool controllers

**Files:** Create `lib/host-plan.mjs`, `lib/native-tool-gate.mjs`, `test/host-plan.test.mjs`, `test/native-tool-gate.test.mjs`; modify `lib/approval.mjs`.

**Interfaces:**
- `readHostPlan({ctx,agent,session}) -> {available,active,loggedActive,pending?,text}`。
- `createPlanBridge({ctx,agent,session,signal}) -> {read,prepare(tool,id,text),permission(tool,id),settle(tool,id,ok),commitBoundary}`。
- `createNativeToolGate({ctx,agent,session,signal,config,epoch}) -> {prepare(call),forPermission(call),approveOnce(call),observe(result)}`；call 含 toolName/input/callId/callerAgentId。
- `makeCanUseTool` 增加可选 toolGate/planBridge；旧调用者语义不变，native plan 工具没有可信桥时不走 generic auto-allow。

- [ ] 写测试并 RED：
```js
assert.equal(readHostPlan({ctx: hostWith({active:true,pending:false}),agent,session}).active, false);
assert.equal((await bridge.prepare('ExitPlanMode','t1','# Plan')).decision,'deny');
assert.equal(planWrites.length,0);
```
- [ ] 最小实现读失败关闭、真实审阅、许可绑定、工具成功后 set、step 提交真实 pending；只读取已核实公开 service shape。
- [ ] 用真实 host waterfall 假协作者验证 gate：同 callId 两入口只触发一次，改参/child/failure 拒绝；宿主 ask 一次审批、重写的 reserved 字段拒绝；read-only 运行中切换立即生效。
- [ ] 运行新测试和既有 `approval.test.mjs`、`host-tool-gate.test.mjs`、完整 suite。

### Task 2: Strict runtime RPC and main-step routing

**Files:** Create `lib/mod-runtime.mjs`, `lib/step-routing.mjs`, `test/mod-runtime.test.mjs`, `test/step-routing.test.mjs`; modify `lib/mod-host.mjs`, `lib/claude-run.mjs`, `lib/session-events.mjs`, `lib/plugin-facts.mjs`.

**Interfaces:**
- `createModRuntime({ctx,agent,session,signal,epoch,toolGate,planBridge,setMode,routeStep,subagents,getDshTools,abort})` supplies fixed `policy/step/tool/check/observe/catalog/dsh` methods with strict schemas and caller rules.
- `createStepRouting({session,agent,getQuery,initialSelection}) -> async prepare(input)` returns only changed model/effort, persists changes using setModel/applyFlagSettings。
- `createModHost({runtime,...})` advertises capabilities only for actual callbacks; child allowed only for named observation/read-only methods, never goals/maintenance/parent DSH execution。

- [ ] RED tests：错 epoch/child prepare-step/未知 method 拒绝；step 只回当前 Plan 与变化路由，`source` 不被请求伪造。
```js
assert.deepEqual(await route.prepare({agentId:'child',model:'child-model'}),{});
assert.equal(setModels.length,0);
```
- [ ] 实现一张固定 RPC 表，保留 normal/maintenance 角色隔离；每次处理检查 signal 与原 agent。runtime 创建仅在该 query 已选择 Mods 时，清理后旧 callback 失效。
- [ ] runner 接入 shared gate、初始 Plan mode、live setter、SDK catalog，fallback 不重放输入；策略/计费控制失败调用 query cancel。
- [ ] 完整 suite，尤其模型、审批、握手 fallback 和多 result 生命周期回归。

### Task 3: Native Mod runtime hooks

**Files:** Create `mods/dsh-bridge/hooks/runtime.mjs`, `mods/dsh-bridge/hooks/runtime.test.ts`; modify bridge.mjs 与 mod-options 的 source stamp。

**Interfaces:** `registerRuntime(on,state)`；state 含 authenticated descriptor、Claude session、capabilities；RPC requestId 使用 runtime 前缀，agentId 仅来自固定事件。

- [ ] 原生测试 RED：prompt policy 一次注入；stream 片段/result 原样通过且 next 一次；main step 改写，child 不改；gate 失败不执行工具；policy check 不把 deny 改 allow。
```ts
expect(coreCalls).toBe(0); // gate unavailable
expect(chunks).toEqual(originalChunks);
```
- [ ] 实现 engine-owned plan path capture、ExitPlanMode 文件读取/变更复核、tool prepare/complete、tool.check 收紧。流式 step 控制失败返回无请求结果并发脱敏 notice，runner 中断，不调用 next 偷跑旧模型。
- [ ] 注册 agent.spawn/turn.complete/session.append 元数据观察；正文不发 RPC，queue 不计 stored row；非权威观察失败不重放执行。
- [ ] 实际 CLI plugin validate/test，Node suite；零推理 fixture 验证 mode/route 控制通道不死锁。

### Task 4: Metadata, context and child identity

**Files:** Create `lib/native-metadata.mjs`, `test/native-metadata.test.mjs`; modify `lib/subagents.mjs`, `test/subagents.test.mjs`, `lib/mod-runtime.mjs`, `lib/claude-run.mjs`。

**Interfaces:** `normalizeContext(snapshot)`、`normalizeCatalog(snapshot)` 返回显式有界数据；`SubagentSessionManager.childSessionIdForToolUseId(id)` 只读查找；runtime `afterMessage()` 补早到身份绑定。

- [ ] RED：非法数字/超过预算/未知正文拒绝；估算标识保留；spawn 在 SDK 子会话之前到达不归 main、之后恰好绑定一次。
```js
assert.throws(()=>normalizeContext({window:NaN,categories:[]}));
assert.equal(snapshot.estimated,true);
```
- [ ] 新事实类型显式准入；有限缓存按 epoch 隔离，无 child lookup 时保留 unknown。SDK projection 不复制，one-shot 不变。
- [ ] SDK reloadSkills 与 Mod commands 目录合并但不将 plugin command 全当 skill。完整 suite + 原生 Mod 元数据测试。

### Task 5: Audited dynamic Mod tool transport

**Files:** Modify `lib/dsh-tools-bridge.mjs`, `lib/claude-run.mjs`, `lib/mod-runtime.mjs`, `mods/dsh-bridge/hooks/bridge.mjs`; extend DSH bridge/SDK/Mod tests。

**Interfaces:** `buildDshToolBridge({ctx,agent,signal,names,toolPrefix}) -> {definitions(),names,execute(name,args,extra),observe,close,server?}`；现有 buildDshToolsServer 包装保持默认 MCP 行为。dshTools.transport=mcp/mod/auto 默认 mcp。

- [ ] RED：初始无可见工具后新增/更新可注册，移除后旧调用拒绝；未审计名、child、错/未确认真实 ID 不能 execute。
```js
assert.equal((await bridge.execute('bash',{},extra)).isError,true);
assert.equal(registryCalls,0);
```
- [ ] 同一查询单选 transport；Mod 动态注册只处理四个审计名，调用每次复核完整当前 schema/可见性、真实归属与信号。缺 unregister 时仅撤销执行许可，不宣称 schema 已删除。
- [ ] SDK MCP 回退重建 controller 并关闭旧 handler，不影响其他 MCP server；动态 auto-allow 只读取当前实际可见审计工具名。
- [ ] 运行 DSH bridge/real SDK contract tests、Mod tests 和完整 suite。

### Task 6: Human commands, skills and documentation

**Files:** Create `lib/command-native.mjs`, `test/command-native.test.mjs`; extend native-operation/native-maintenance/agent/Mod；modify package exports、preset、README 中英文及互动指南。

**Interfaces:** agent 提供最近 context/catalog 的只读视图与显式 native command 维护入口；`/claude-context`、`/claude-commands` 仅展示最近观察；`/claude-command status|cost` 仅只读 builtin；`/claude-skill name args` 只对配置 allowlist ∩ SDK skills 生成真实用户来源 followup。

- [ ] RED：列表不是授权；未知/未允许/非 skill 不能 enqueue，精确允许 skill 只 enqueue 一次且不启动维护模型；状态 text 不写私有日志正文。
```js
assert.equal((await runSkill('not-allowed')).kind,'error');
assert.equal(followups.length,0);
```
- [ ] 按真实 command runtime 注册/drain，所有命令拒绝缺 live agent。普通生成仍经过 input ledger、权限、审批，不提供模型可调用的任意命令工具。
- [ ] 完整 Node suite、两个 Mod validate/test、语法、package dry-run、diff 检查；新鲜只读 reviewer 对整个工作区 diff 审查，重要问题 RED→GREEN 修复一次，明确未做的付费/桌面验收。
