// 人看的原生观察与受限技能入口；列表不是授权，生成仍走既有输入/审批管线。
import { randomUUID } from "node:crypto";
import { scopeOf } from "@deepseek-ai/dsh-scope";
export const name = "claude-code-command-native";
export const inject = ["commands"];
const error = text => ({ kind: "error", text });
function snapshotsOf(invocation) {
  if (typeof invocation.agent?.nativeSnapshots !== "function") throw new Error("not a native CLI agent");
  return invocation.agent.nativeSnapshots();
}
function describeContext(context) {
  const lines = [`Last native CLI context (estimated summary): ${context.window} token window`];
  if (context.tokens !== undefined) lines.push(`API-reported input: ${context.tokens}${context.percent === undefined ? "" : ` (${context.percent}%)`}`);
  if (context.model) lines.push(`Model: ${context.model}`);
  for (const row of context.categories ?? []) lines.push(`- ${row.name}: ~${row.tokens} [${row.kind}]`);
  if (context.truncated) lines.push("(more rows were truncated)");
  lines.push("Source: last Mod-reported CLI summary; DSH's own breakdown panel is unchanged.");
  return lines.join("\n");
}
function describeCatalog(catalog) {
  const commands = catalog.commands ?? [], skills = catalog.skills ?? [];
  const lines = [`Last native CLI catalog: ${commands.length} plugin/builtin command(s), ${catalog.skillsObserved ? `${skills.length} SDK skill(s)` : "skills not observed"}.`];
  if (commands.length) lines.push(`Commands: ${commands.map(command => `/${command.name} [${command.source}]`).join(", ")}`);
  if (catalog.skillsObserved && skills.length) lines.push(`Skills: ${skills.map(skill => skill.name).join(", ")}`);
  if (catalog.truncated) lines.push("(the catalog was truncated to its bound)");
  lines.push("This list is not an authorization: only the configured allowlist can send a skill.");
  return lines.join("\n");
}

export function apply(ctx) {
  const active = new Set(); const owner = scopeOf(ctx); let closed = false;
  const requireAgent = invocation => {
    const agent = invocation.agent;
    if (closed || invocation.signal?.aborted || !agent || agent.disposed === true || !agent.session
      || owner !== undefined && owner !== agent) throw new Error("no live command owner");
    const registry = ctx.get("agents");
    if (registry && registry.get(agent.id) !== agent) throw new Error("command owner changed");
    if (invocation.attachments?.length) throw new Error("attachments are not supported");
    return agent;
  };
  const handler = run => invocation => {
    if (closed) return Promise.resolve(error("Native command scope is closed."));
    const operation = Promise.resolve().then(() => {
      try { requireAgent(invocation); } catch { return error("This command requires a live owner and does not accept attachments."); }
      return run(invocation);
    }).catch(() => error("Native command failed; no success was confirmed."));
    active.add(operation);
    const retire = () => { active.delete(operation); }; void operation.then(retire, retire);
    return operation;
  };
  const showContext = handler(invocation => {
    if (invocation.rawInput.trim()) return error("Usage: /claude-context (no arguments)");
    try {
      const context = snapshotsOf(invocation).context;
      return { kind: "success", text: context ? describeContext(context) : "No native context observation yet; run a turn in this session first." };
    } catch { return error("Native observations are unavailable or unreadable for this agent."); }
  });
  const showCatalog = handler(invocation => {
    if (invocation.rawInput.trim()) return error("Usage: /claude-commands (no arguments)");
    try {
      const catalog = snapshotsOf(invocation).catalog;
      return { kind: "success", text: catalog ? describeCatalog(catalog) : "No native catalog observation yet; run a turn in this session first." };
    } catch { return error("Native observations are unavailable or unreadable for this agent."); }
  });
  const runNative = handler(async invocation => {
    const command = invocation.rawInput.trim();
    if (command !== "status" && command !== "cost") return error("Usage: /claude-command status|cost");
    const agent = invocation.agent;
    if (typeof agent.nativeCommand !== "function") return error("Native commands are unavailable for this agent.");
    try {
      const result = await agent.nativeCommand({ signal: invocation.signal, commandId: invocation.commandId, command });
      if (result?.status !== "succeeded" || typeof result.text !== "string" || !result.text.trim()) return error(`Native ${command} returned no confirmed text result.`);
      return { kind: "success", text: `\`/${command}\`\n${result.text}` };
    } catch (cause) {
      const code = ["busy", "history", "fork", "unsupported", "cancelled", "timeout"].includes(cause?.code) ? cause.code : "failed";
      return error(`Native ${command} ${code}.${cause?.uncertain ? " Inspect CLI state before retrying; execution may be uncertain." : ""}`);
    }
  });
  const sendSkill = handler(invocation => {
    const agent = invocation.agent;
    const match = invocation.rawInput.match(/^\s*(\S+)([\s\S]*)$/);
    if (!match) return error("Usage: /claude-skill <name> [args]");
    const skillName = match[1];
    const allowed = agent.config?.mods?.skills?.allowed;
    if (!Array.isArray(allowed) || !allowed.includes(skillName)) return error(`Skill "${skillName}" is not in engines.claude-code.mods.skills.allowed.`);
    let catalog;
    try { catalog = snapshotsOf(invocation).catalog; } catch { return error("Native observations are unavailable or unreadable for this agent."); }
    if (!catalog?.skillsObserved || catalog.skillsSource !== "sdk-reload-skills" || !catalog.skills?.some(skill => skill.name === skillName)) return error(`"${skillName}" was not observed as a native CLI skill; refusing to send it.`);
    if (typeof agent.followup !== "function" || invocation.signal?.aborted) return error("This agent cannot accept the skill request.");
    agent.followup({ id: randomUUID(), role: "user", source: { kind: "user" }, content: [{ type: "text", text: `/${skillName}${match[2]}` }] });
    return { kind: "success", text: `Queued /${skillName} as a normal user turn; execution still uses the CLI's permissions.` };
  });
  ctx.effect(function* () {
    yield async () => { await Promise.allSettled(active); };
    const commands = ctx.get("commands");
    yield commands.register({ definitionId: "dsh-claude-code/claude-context", name: "claude-context", description: "Show the last native CLI context summary", handler: showContext });
    yield commands.register({ definitionId: "dsh-claude-code/claude-commands", name: "claude-commands", description: "Show the last native CLI command/skill catalog", handler: showCatalog });
    yield commands.register({ definitionId: "dsh-claude-code/claude-command", name: "claude-command", description: "Run a fixed read-only native builtin", input: { hint: "status|cost" }, handler: runNative });
    yield commands.register({ definitionId: "dsh-claude-code/claude-skill", name: "claude-skill", description: "Queue an allowlisted, observed CLI skill", input: { hint: "<name> [args]" }, handler: sendSkill });
    yield () => { closed = true; };
  }, "claude-code native commands");
}
