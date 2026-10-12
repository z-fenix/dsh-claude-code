// lib/approval.mjs — Claude Code 的 canUseTool 回调 → DSH 审批 seam（`ctx.approval.request`）。
//
// 无应答者 / 服务缺失 / 异常一律 fail-closed（deny）：这是权限边界，不能默认放行。
//
// 契约（@anthropic-ai/claude-agent-sdk 的 CanUseTool）：回调必须返回 PermissionResult 对象：
//   { behavior: 'allow', updatedInput?, updatedPermissions?, toolUseID? }
//   { behavior: 'deny', message: string, interrupt?, toolUseID? }
import { isWithinWorkspace, readPermission, permissionStrategy } from "./permission.mjs";
import { readSessionEvents } from "./session-events.mjs";

/** 从工具入参里提取最可读的「要干什么」摘要（命令 / 路径 / url …）。 */
function inputSummary(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);
  for (const key of ["command", "file_path", "path", "url", "pattern", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return JSON.stringify(input);
}

/**
 * 桥接 AskUserQuestion：直接在 canUseTool 里弹 DSH 选择题，把答案作为 deny 的 message 返回
 * ——Claude 能从 message 读到用户的选择。
 *
 * 这样处理而不是依赖 SDK 的 request_user_dialog：后者在 headless 下并不总能可靠触发，
 * 而 canUseTool 一定会被调用。
 */
async function bridgeAskUserQuestion(ctx, agent, input, signal) {
  const userQuestions = ctx.get("userQuestions");
  if (!userQuestions || !agent) {
    return { behavior: "deny", message: "dsh-claude-code: no user-questions provider or agent for AskUserQuestion" };
  }
  try {
    const dshQuestions = (input?.questions ?? []).map((q, i) => ({
      id: q?.header ?? q?.question ?? `q${i}`,
      question: typeof q?.question === "string" ? q.question : "",
      ...(typeof q?.header === "string" ? { header: q.header } : {}),
      ...(Array.isArray(q?.options) && q.options.length
        ? {
          options: q.options.map((o) => ({
            label: String(o?.label ?? ""),
            ...(o?.description ? { description: o.description } : {}),
          })),
        }
        : {}),
      ...(q?.multiSelect ? { multiSelect: true } : {}),
    }));
    if (!dshQuestions.length) {
      return { behavior: "deny", message: "dsh-claude-code: AskUserQuestion without questions" };
    }
    const answer = await userQuestions.ask({ questions: dshQuestions, agent, ...(signal ? { signal } : {}) });
    const summary = (answer?.answers ?? [])
      .map((a) => {
        const value = a?.custom ?? (Array.isArray(a?.selected) ? a.selected.join(", ") : "");
        return value ? `${a.id ?? "?"}: ${value}` : "";
      })
      .filter(Boolean)
      .join("; ");
    return { behavior: "deny", message: summary || "(no selection)" };
  } catch (error) {
    return { behavior: "deny", message: String(error?.message ?? error) };
  }
}

/**
 * 生成 canUseTool 回调。
 *
 * 每次工具调用都重读会话的最新权限（读日志折叠），因此回合中途把权限切成 Full access
 * 或 never 时，**后续**工具调用立即按新策略判定，而不是沿用回合起点的快照。
 *
 * @param {object} ctx 取 `approval` / `userQuestions` 服务的上下文
 * @param {object} options
 * @param {string} options.cwd 工作区根目录
 * @param {object} options.session 会话（供每次调用重读权限）
 * @param {object} options.agent 当前 agent，供审批 / 选择题定位所属会话
 * @returns {(toolName: string, input: object, extra?: object) => Promise<object>} canUseTool 回调
 */
export function makeCanUseTool(ctx, { cwd, session, agent } = {}) {
  return async function canUseTool(toolName, input, { signal, title, displayName, blockedPath, decisionReason } = {}) {
    // AskUserQuestion 是「向用户提问」这一交互本身，不是受权限门控的动作，所以必须**先于**
    // 任何策略短路处理：ask / no-prompt / danger-full-access 下都要送到 DSH 选择题 UI。
    // 顺序至关重要——若让下面的 bypass 短路先返回 allow，CLI 会把 allow 读成「用户已批准
    // 这次提问」，于是根本不弹窗（问题永远到不了用户眼前），工具在零答案下直接返回
    // 「The user did not answer the questions.」。实测：回合中途从 workspace-write 切到
    // Full access 后，紧接着的 AskUserQuestion 就是这样被吞掉的。
    if (toolName === "AskUserQuestion") return await bridgeAskUserQuestion(ctx, agent, input, signal);

    // 每次现读：回合中切 Full access / never 立即生效。
    const strategy = permissionStrategy(readPermission(readSessionEvents(session)));

    // danger-full-access：完全放行（提问以外的工具）。
    if (strategy === "bypass") return { behavior: "allow" };

    // 工作区内放行：有明确路径且落在工作区内（workspace-write / no-prompt 共用）。
    if (blockedPath && isWithinWorkspace(cwd, blockedPath)) return { behavior: "allow" };

    // no-prompt（approval policy = never）：不弹窗，区外一律拒绝。
    if (strategy === "no-prompt") {
      return { behavior: "deny", message: `dsh-claude-code: denied by approval policy (never) for tool ${toolName}` };
    }

    // ask：走 DSH 原生审批 seam，等用户「允许一次 / 拒绝」。
    if (!agent) return { behavior: "deny", message: "dsh-claude-code: no live agent for approval" };
    const approval = ctx.get("approval");
    if (!approval) {
      return { behavior: "deny", message: "dsh-claude-code: no approval service (dsh-user-approval not composed)" };
    }
    try {
      // 审批 UI 只显示 toolName + reason，所以把「具体命令 / 路径 / 原因」都拼进 reason，
      // 避免用户只看到 "Bash" 就要做决定。
      const reason = [
        inputSummary(input),
        decisionReason ?? title ?? displayName,
        blockedPath ? `path: ${blockedPath}` : "",
      ].filter(Boolean).join(" · ");
      const outcome = await approval.request({
        agent,
        toolName,
        ...(reason ? { reason } : {}),
        ...(signal ? { signal } : {}),
      });
      return outcome === "allowed-once"
        ? { behavior: "allow" }
        : { behavior: "deny", message: `dsh-claude-code: approval ${outcome}` };
    } catch (error) {
      // 无开放回合 / 审计写入失败 / 应答者异常 → fail closed。
      return { behavior: "deny", message: String(error?.message ?? error) };
    }
  };
}
