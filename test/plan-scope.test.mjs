import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";
import { readHostPlan } from "../lib/host-plan.mjs";

test("planning 隔离服务按真实 agent scope 绑定，卸载后撤销", async () => {
  const { apply } = await import("../lib/plan-scope.mjs");
  const ctx = new Context();
  const service = { get: () => ({ active: false, pending: true }), section: "Plan with exit_plan_mode.", set() {} };
  ctx.provide("planMode", service);
  const agent = { session: { snapshotEvents: () => [] } };
  const scope = createScope(ctx, agent);
  try {
    apply(scope.ctx);
    const state = readHostPlan({ ctx: { get() {} }, agent });
    assert.equal(state.available, true);
    assert.equal(state.active, true);
    assert.match(state.text, /ExitPlanMode/);
  } finally { await scope.dispose(); }
  assert.equal(readHostPlan({ ctx: { get() {} }, agent }).available, false);
});
