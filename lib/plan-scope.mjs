// planning group 隔离了 planMode；按 dsh-scope 的真实 agent 键导出只供本适配器使用的绑定。
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { bindHostPlanService } from "./host-plan.mjs";
export const name = "claude-code-plan-scope";
export const inject = ["planMode"];
export function apply(ctx) {
  ctx.effect(() => bindHostPlanService(scopeOf(ctx), ctx.get("planMode")), "claude-code Plan scope binding");
}
