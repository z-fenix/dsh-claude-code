// 两个 realm 共用的参数改写边界：只改已审计自由字段，其余原生约束保持原值。
const FIELDS = {
  Write: { file_path: "string", content: "string" },
  Edit: { file_path: "string", old_string: "string", new_string: "string", replace_all: "boolean" },
  MultiEdit: { file_path: "string" },
  NotebookEdit: { notebook_path: "string", new_source: "string" },
};
const RESERVED = new Set(["tool", "tool_use_id", "agentId", "callerAgentId", "consent", "requestMeta", "__proto__", "constructor", "prototype"]);
export function canonicalJson(value) {
  const seen = new Set();
  const order = (item, depth) => {
    if (depth > 128) throw new Error("tool argument nesting exceeds budget");
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) throw new Error("cyclic tool arguments");
    seen.add(item);
    const result = Array.isArray(item) ? item.map(child => order(child, depth + 1))
      : Object.fromEntries(Object.keys(item).sort().map(key => [key, order(item[key], depth + 1)]));
    seen.delete(item);
    return result;
  };
  return JSON.stringify(order(value, 0));
}
export function validateToolRewrite(tool, original, candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || Object.keys(candidate).some(key => RESERVED.has(key))) throw new Error("invalid native tool rewrite");
  for (const key of new Set([...Object.keys(original), ...Object.keys(candidate)])) {
    if (canonicalJson(original[key]) === canonicalJson(candidate[key])) continue;
    const type = Object.hasOwn(FIELDS, tool) && Object.hasOwn(FIELDS[tool], key) ? FIELDS[tool][key] : undefined;
    if (type === undefined || typeof candidate[key] !== type) throw new Error("unsupported native tool argument rewrite");
  }
  return JSON.parse(JSON.stringify(candidate));
}
