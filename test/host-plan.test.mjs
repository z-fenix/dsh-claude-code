import { test } from "node:test";
import assert from "node:assert/strict";
const load = () => import("../lib/host-plan.mjs");
function fixture() {
  const events = [];
  let active = true;
  let pending;
  let answer = { answers: [{ id: "claude-plan-review", selected: ["Approve plan"] }] };
  let reviews = 0;
  const writes = [];
  const session = { snapshotEvents: () => events, append(type, data) { events.push({ type, data, seq: events.length }); active = data.active; } };
  const service = { section: "In plan mode, call exit_plan_mode and ask_user_question.", get: () => ({ active, ...(pending === undefined ? {} : { pending }) }),
    set(_agent, value) { writes.push(value); pending = value; return "queued"; } };
  const ctx = { get: (name) => name === "planMode" ? service : name === "userQuestions" ? { ask: async (input) => {
    reviews += 1; assert.equal(input.questions[0].intent.kind, "plan-review"); return answer;
  } } : undefined };
  const agent = { id: "a1", session };
  return { ctx, agent, session, service, writes, get reviews() { return reviews; }, setPending(value) { pending = value; }, setAnswer(value) { answer = value; } };
}

test("pending:false 是退出目标，Plan guidance 翻译已知 CLI 工具名", async () => {
  const { readHostPlan } = await load(); const world = fixture();
  world.setPending(false);
  const state = readHostPlan(world);
  assert.equal(state.active, false);
  assert.equal(state.loggedActive, true);
  world.setPending(true);
  assert.match(readHostPlan(world).text, /ExitPlanMode/);
  assert.ok(!readHostPlan(world).text.includes("exit_plan_mode"));
});

test("真实审批只给同一次 native plan 调用许可，工具成功后才选择退出", async () => {
  const { createPlanBridge } = await load(); const world = fixture();
  const bridge = createPlanBridge({ ...world, signal: new AbortController().signal });
  assert.equal(bridge.permission("ExitPlanMode", "unknown").behavior, "deny");
  assert.equal((await bridge.prepare("ExitPlanMode", "t1", "# Plan\nRead then edit")).decision, "allow");
  assert.equal(world.reviews, 1);
  assert.deepEqual(world.writes, []);
  assert.equal(bridge.permission("ExitPlanMode", "t1").behavior, "allow");
  assert.equal(bridge.permission("EnterPlanMode", "t1").behavior, "deny");
  bridge.settle("ExitPlanMode", "t1", true);
  assert.deepEqual(world.writes, [false]);
  assert.equal(world.session.snapshotEvents().length, 0);
  bridge.commitBoundary();
  assert.deepEqual(world.session.snapshotEvents().map(x => [x.type,x.data]), [["plan/mode", { active: false }]]);
});

for (const answer of [
  { answers: [{ id: "claude-plan-review", selected: ["Keep planning"] }] },
  { answers: [{ id: "claude-plan-review", selected: ["Approve plan"], custom: "changed" }] },
  { answers: [] },
]) test("拒绝、反馈或缺失答案不退出 Plan", async () => {
  const { createPlanBridge } = await load(); const world = fixture(); world.setAnswer(answer);
  const bridge = createPlanBridge(world);
  assert.equal((await bridge.prepare("ExitPlanMode", "t1", "# Plan")).decision, "deny");
  assert.deepEqual(world.writes, []);
  assert.equal(bridge.permission("ExitPlanMode", "t1").behavior, "deny");
});

test("状态读取失败不降级为 inactive，无正文不弹审阅", async () => {
  const { readHostPlan, createPlanBridge } = await load(); const world = fixture();
  world.service.get = () => { throw new Error("state unreadable"); };
  assert.throws(() => readHostPlan(world), /unreadable/);
  const other = fixture(); const bridge = createPlanBridge(other);
  assert.equal((await bridge.prepare("ExitPlanMode", "t1", "")).decision, "deny");
  assert.equal(other.reviews, 0);
});

test("Plan 只允许主循环写原生计划文件，pending 退出未接受前不放开", async () => {
  const { createPlanBridge } = await load(); const world = fixture();
  world.session.header = { cwd: "/w" };
  const bridge = createPlanBridge(world);
  bridge.rememberPath("/w/plan.md");
  assert.equal(bridge.guard("Write", { file_path: "/w/plan.md" }), undefined);
  assert.match(bridge.guard("Write", { file_path: "/w/other.md" }), /plan/i);
  assert.match(bridge.guard("Write", { file_path: "/w/plan.md" }, "child"), /plan/i);
  world.setPending(false);
  assert.match(bridge.guard("Edit", { file_path: "/w/other.md" }), /plan/i);
  bridge.commitBoundary();
  assert.equal(bridge.guard("Write", { file_path: "/w/other.md" }), undefined);
});

test("审阅请求取消或桥关闭后旧许可失效", async () => {
  const { createPlanBridge } = await load(); const world = fixture();
  const request = new AbortController();
  const gate = Promise.withResolvers();
  const originalGet = world.ctx.get;
  world.ctx.get = (name) => name === "userQuestions" ? { ask: () => gate.promise } : originalGet(name);
  const bridge = createPlanBridge(world);
  const review = bridge.prepare("ExitPlanMode", "t1", "# Plan", request.signal);
  request.abort();
  gate.resolve({ answers: [{ id: "claude-plan-review", selected: ["Approve plan"] }] });
  assert.equal((await review).decision, "deny");
  assert.equal(bridge.permission("ExitPlanMode", "t1").behavior, "deny");
  await bridge.prepare("EnterPlanMode", "t2");
  bridge.close();
  assert.equal(bridge.permission("EnterPlanMode", "t2").behavior, "deny");
});

test("CLI 工具失败或审阅后状态变更不能提交退出", async () => {
  const { createPlanBridge } = await load(); const world = fixture();
  const bridge = createPlanBridge(world);
  await bridge.prepare("ExitPlanMode", "t1", "# Plan");
  bridge.settle("ExitPlanMode", "t1", false);
  assert.deepEqual(world.writes, []);
  assert.equal(bridge.permission("ExitPlanMode", "t1").behavior, "deny");
});
