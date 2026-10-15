// 公开 view 的有限同步 guard；不证明宿主私有 reservation，也不修改目标。
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
