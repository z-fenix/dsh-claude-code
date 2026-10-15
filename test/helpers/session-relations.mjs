import { apply } from "@deepseek-ai/dsh-session/invariant";

export async function assertSessionRelations(session) {
  const listeners = new Map();
  const ctx = {
    sessions: { list: () => [session] },
    on(name, callback) { listeners.set(name, callback); },
    invariants: {
      register(_name, install) {
        return install(ctx, (message) => { throw new Error(`session relations: ${message}`); });
      },
    },
  };
  await apply(ctx);
}
