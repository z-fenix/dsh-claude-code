// 测试专用公开 view；只有原生 user/message 推进 roundsStarted。
export function wireGoalFixture(ctx, getAgent) {
  const state = { view: { id: "g1", revision: 1, phase: "active", activation: "armed",
    roundsStarted: 0, maxGoalRounds: 3 }, error: undefined, reads: 0,
    onNativeEvent(event) {
      const source = event.data?.source;
      if (event.type === "user/message" && source?.kind === "goal") {
        if (source.goalId !== state.view?.id || source.revision !== state.view.revision
          || source.round !== state.view.roundsStarted + 1) throw new Error("fixture: invalid native goal admission");
        state.view.roundsStarted = source.round;
      }
    } };
  ctx.provide("agents", { get: (id) => getAgent()?.id === id ? getAgent() : undefined,
    withInitiator: async (_agent, fn) => fn() });
  ctx.provide("goals", { get(agent) {
    if (agent !== getAgent()) throw new Error("fixture: not live");
    state.reads += 1;
    if (state.error) throw state.error;
    return state.view === undefined ? undefined : structuredClone(state.view);
  } });
  return state;
}
