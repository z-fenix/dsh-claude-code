import { test } from "node:test";
import assert from "node:assert/strict";
const load = () => import("../lib/step-routing.mjs");
function world() {
  const events = [];
  const models = [], settings = [];
  const query = { setModel: async (x) => models.push(x), applyFlagSettings: async (x) => settings.push(x) };
  return { session: { snapshotEvents: () => events }, agent: { options: { model: "initial" } },
    events, models, settings, getQuery: () => query };
}

test("主 step 才采纳变化的选择，后续不压过 CLI fallback", async () => {
  const { createStepRouting } = await load(); const w = world();
  const route = createStepRouting(w);
  assert.deepEqual(await route.prepare({ model: "native-fallback" }), {});
  w.events.push({ type: "model/selection", data: { provider: "p", model: "chosen", reasoningEffort: "high" } });
  assert.deepEqual(await route.prepare({ agentId: "child", model: "child-model" }), {});
  assert.deepEqual(w.models, []);
  assert.deepEqual(await route.prepare({ model: "initial" }), { model: "chosen", effort: "high" });
  assert.deepEqual(w.models, ["chosen"]);
  assert.deepEqual(w.settings, [{ effortLevel: "high" }]);
  assert.deepEqual(await route.prepare({ model: "native-fallback" }), {});
  assert.deepEqual(w.models, ["chosen"]);
});

test("清除 effort 不猜 budget，未知档位不透传", async () => {
  const { createStepRouting } = await load(); const w = world();
  w.events.push({ type: "model/selection", data: { provider: "p", model: "initial", reasoningEffort: "max" } });
  const route = createStepRouting(w);
  w.events.push({ type: "model/selection", data: { provider: "p", model: "initial", reasoningEffort: "ultra" } });
  assert.deepEqual(await route.prepare({ model: "initial", effort: "max" }), { clearEffort: true });
  assert.deepEqual(w.settings, [{ effortLevel: null }]);
  assert.deepEqual(w.models, []);
});

test("选择读取或 SDK 控制失败不伪报切换成功", async () => {
  const { createStepRouting } = await load(); const w = world();
  const route = createStepRouting({ ...w, getQuery: () => ({ setModel: async () => { throw new Error("unavailable"); } }) });
  w.events.push({ type: "model/selection", data: { provider: "p", model: "chosen" } });
  await assert.rejects(route.prepare({ model: "initial" }), /unavailable/);
  const broken = createStepRouting({ ...world(), initialSelection: { model: "initial" }, session: { snapshotEvents() { throw new Error("unreadable"); } } });
  await assert.rejects(broken.prepare({ model: "initial" }), /unreadable/);
});
