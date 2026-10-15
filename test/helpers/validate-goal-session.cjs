// 仅验证本计划合成日志；Electron Node 模式只读使用安装版校验器。
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
const { header, events, expectedRounds, expectedUserIds } = JSON.parse(readFileSync(path, "utf8"));
events.forEach((event, seq) => {
  assert.equal(event.seq, seq);
  assertV4RowAdmission(event, KNOWN_SESSION_EVENT_TYPES);
});
assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES);
assert.equal(foldGoal(events).roundsStarted, expectedRounds);
assert.deepEqual(events.filter((event) => event.type === "user/message").map((event) => event.data.id), expectedUserIds);
const automatic = events.find((event) => event.type === "user/message" && event.data.source?.kind === "goal");
if (automatic) {
  assert.throws(() => foldGoal([...events, { ...automatic, seq: events.length }]), /next admitted round/);
  assert.throws(() => foldGoal([...events, { ...automatic, seq: events.length,
    data: { ...automatic.data, source: { ...automatic.data.source, round: 0 } } }]), /source is invalid/);
}
console.log(JSON.stringify({ artifact: basename(path), events: events.length,
  nativeV4: "passed", goalReplay: "passed", rounds: expectedRounds,
  ...(automatic ? { negativeControls: "duplicate-round and round-zero rejected" } : {}),
}));
