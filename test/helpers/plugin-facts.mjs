// 显式内存后端：原生 events/snapshotEvents 保持纯净，私有事实单独提供。
import { PluginFacts, bindPluginFacts } from "../../lib/plugin-facts.mjs";

export function attachFacts(session, records = [], onFact = () => {}) {
  const stored = structuredClone(records);
  session.factRecords = stored;
  const storage = {
    read: () => structuredClone(stored),
    append(record) {
      session.rejectFact?.(record);
      stored.push(structuredClone(record));
      onFact(record);
    },
    close() {},
  };
  session.facts = bindPluginFacts(session, new PluginFacts(session, { storage }));
  session.factEvents = () => session.facts.events();
  return session;
}
