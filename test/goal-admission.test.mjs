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

// Missing source/view/lifecycle checks would admit stale automatic messages.
for (const round of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`source-invalid round ${round} 不读取 goal`, () => {
    const message = goalMessage({ round });
    const decision = check([message], { readGoal() { assert.fail("must not read"); } });
    assert.deepEqual(decision, { kind: "reject", code: "source-invalid", messages: [message] });
    assert.equal(decision.messages[0], message);
  });
}
for (const [patch, code] of [
  [{ id: "old" }, "goal-mismatch"], [{ revision: 2 }, "goal-mismatch"],
  [{ phase: "paused" }, "goal-inactive"], [{ phase: "blocked" }, "goal-inactive"],
  [{ phase: "complete" }, "goal-inactive"], [{ activation: "disarmed" }, "goal-disarmed"],
  [{ roundsStarted: 1 }, "round-mismatch"], [{ maxGoalRounds: 0 }, "goal-read-failed"],
  [{ phase: "completed" }, "goal-read-failed"], [{ roundsStarted: -1 }, "goal-read-failed"],
  [{ revision: 0 }, "goal-read-failed"], [{ activation: "unknown" }, "goal-read-failed"],
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
test("失效 lifecycle 不读取 goal", () => {
  const decision = check([goalMessage()], { isLive: () => false,
    readGoal() { assert.fail("must not read"); } });
  assert.equal(decision.kind, "hold");
  assert.equal(decision.code, "lifecycle-ended");
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
for (const source of [{ goalId: "" }, { goalId: null }, { revision: 0 }, { revision: 1.5 }]) {
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
