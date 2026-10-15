// lib/host-persona.mjs — 把宿主装配的 persona 段落按项桥接给 Claude。
//
// 本插件刻意不派发 `agent/pre-step`（见 docs/superpowers/specs/2026-10-13-agent-pre-step-design.md），
// 于是宿主 `systemPrompt.assemble()` 的产物从来不会进入模型请求。宿主的装配里混着三类东西，
// 只有 persona 适合逐项转发：
//
//   - `deployment:persona-prefix` / `deployment:persona-suffix`：**部署方在预设里写死的身份文本**
//     （本插件的预设写的是「You are Claude Code, an agent working inside DeepSeek Harness.」）。
//     丢掉它等于用户配的 persona 在 Claude 会话里静默失效，所以这里显式转发。
//   - 各工具段落（`tool:bash`、`tool:read` …）：描述的是 **DSH 的工具**。Claude 用的是 CLI
//     自带的那套，转发过去就是在告诉模型它有一批并不存在的工具。
//   - runtime contexts（沙箱/审批策略等）：描述的是 **DSH 的执行边界**；Claude 模式下真正生效的
//     是本插件的 permission/approval 策略，转过去等于虚构一层并不存在的沙箱。
//
// 所以本模块只做一件事：按名字白名单取 persona 两段，用宿主自己的变量插值，其余一律不碰。
// 任何失败都退化成「不转发」（有 reason），绝不抛错、绝不发空文本、绝不把 `{{cwd}}` 原样发给模型。

/** 允许转发的段落名。宿主用同名段落实现「预设 persona 遮蔽部署 persona」，故名字必须一致。 */
export const PERSONA_SECTION_NAMES = ["deployment:persona-prefix", "deployment:persona-suffix"];

/** 变量引用：与宿主一致，只认完整的简单 `{{name}}` 组。 */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * 按宿主的插值语义渲染一段文本。
 *
 * 与宿主 `renderPrompt` 的差别只有一处：宿主对未知变量抛错，这里把它当作「不转发」。
 * 段落里残留 `{{cwd}}` 这类字面量发给模型是误导，所以宁可整段不发。
 *
 * @param {{text?: unknown, interpolate?: boolean}} section 段落
 * @param {Record<string, unknown>} variables 装配提供的变量
 * @returns {{text: string, missing: string[]}} 渲染结果与缺失的变量名
 */
function renderSection(section, variables) {
  const text = typeof section.text === "string" ? section.text : "";
  if (section.interpolate === false) return { text, missing: [] };
  const missing = [];
  let result = "";
  let last = 0;
  for (let open = text.indexOf("{{", last); open >= 0; open = text.indexOf("{{", last)) {
    const close = text.indexOf("}}", open + 2);
    if (close < 0) {
      // 落单的 `{{` 是字面散文，与宿主一致
      result += text.slice(last, open + 2);
      last = open + 2;
      continue;
    }
    const name = text.slice(open + 2, close);
    if (!VARIABLE_NAME.test(name)) {
      missing.push(name);
      result += text.slice(last, close + 2);
      last = close + 2;
      continue;
    }
    const value = variables[name];
    if (value === undefined) {
      missing.push(name);
      result += text.slice(last, close + 2);
      last = close + 2;
      continue;
    }
    result += text.slice(last, open) + String(value);
    last = close + 2;
  }
  return { text: result + text.slice(last), missing };
}

/**
 * 读取并渲染宿主为这个 agent 装配的 persona 段落。
 *
 * @param {object} options
 * @param {object} options.ctx 取宿主 `systemPrompt` 服务的上下文（宿主服务只能用 `ctx.get`）
 * @param {object} options.agent 本会话的 agent；宿主用它作装配 scope（`assembleContextFor` 的形状）
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ text: string, sections: number, reason?: string }>} 要转发给 Claude 的文本；
 *   `sections` 是宿主装配里命中的 persona 段数，`reason` 说明为何没转发。
 *
 *   `sections` 不是装饰：真宿主在**全局**无条件注册这两段空 persona，所以 agent scope 没挂
 *   persona 时装配里照样有两段——`text` 是空串、`reason` 是 undefined，只看这两个字段分不出
 *   「宿主本来就没配 persona」和「配了但没转到」。段数把这两种形状分开。
 */
export async function readHostPersona({ ctx, agent, signal }) {
  let service;
  try {
    service = ctx?.get?.("systemPrompt");
  } catch {
    service = undefined;
  }
  if (service === undefined || typeof service.assemble !== "function") {
    return { text: "", sections: 0, reason: "this host exposes no systemPrompt service" };
  }

  let assembly;
  try {
    assembly = await service.assemble({
      agent,
      scope: agent,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    return { text: "", sections: 0, reason: `systemPrompt.assemble failed: ${String(error?.message ?? error)}` };
  }

  const byName = new Map();
  for (const section of Array.isArray(assembly?.sections) ? assembly.sections : []) {
    if (section !== null && typeof section === "object" && PERSONA_SECTION_NAMES.includes(section.name)) {
      byName.set(section.name, section);
    }
  }
  if (byName.size === 0) return { text: "", sections: 0, reason: "the host assembled no persona section for this agent" };
  if ([...byName.values()].some((section) => section.complete === true)) {
    // `complete: true` 的语义是「这一段就是整份提示词」。append 表达不了替换，照发过去
    // 会让 DSH 侧以为 persona 已生效、模型侧那份 persona 的边界却被悄悄改写。如实不转发。
    return { text: "", sections: byName.size, reason: "the host marks this persona complete (it replaces the whole prompt); append cannot express that" };
  }

  const variables = assembly?.variables !== null && typeof assembly?.variables === "object" ? assembly.variables : {};
  const rendered = [];
  const unrendered = [];
  for (const name of PERSONA_SECTION_NAMES) {
    const section = byName.get(name);
    if (section === undefined) continue;
    const { text, missing } = renderSection(section, variables);
    if (missing.length > 0) {
      unrendered.push(`${name} (unknown variable ${missing.join(", ")})`);
      continue;
    }
    if (text.trim() !== "") rendered.push(text);
  }

  return {
    text: rendered.join("\n\n"),
    sections: byName.size,
    ...(unrendered.length === 0 ? {} : {
      reason: `persona section not forwarded: ${unrendered.join("; ")}`,
    }),
  };
}
