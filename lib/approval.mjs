// lib/approval.mjs — Claude Code 的 canUseTool 回调 → DSH 审批 seam（`ctx.approval.request`）。
//
// 无应答者 / 服务缺失 / 异常一律 fail-closed（deny）：这是权限边界，不能默认放行。
//
// 契约（@anthropic-ai/claude-agent-sdk 的 CanUseTool）：回调必须返回 PermissionResult 对象：
//   { behavior: 'allow', updatedInput?, updatedPermissions?, toolUseID? }
//   { behavior: 'deny', message: string, interrupt?, toolUseID? }
import { isWithinWorkspace, readPermission, permissionStrategy } from "./permission.mjs";
import { readSessionEvents } from "./session-events.mjs";
import { GOAL_TOOL_PREFIX } from "./goal-bridge.mjs";
import { dispatchHostToolGate, FILE_TOOL_WIRE_NAMES } from "./host-tool-gate.mjs";

/**
 * 精确放行的 goal 桥接工具名。只放行这三个语义工具，而不是 `mcp__goal__` 前缀下的全部工具名
 * ——否则任何挂在名为 goal 的 MCP server 下的工具都会被无条件放行（放行范围应最小）。
 */
const GOAL_TOOL_NAMES = new Set(["get_goal", "create_goal", "update_goal"].map((n) => GOAL_TOOL_PREFIX + n));

/**
 * Claude Code 自带的**可写文件**工具。
 *
 * standard 会话的写限制由 DSH 的文件沙箱兜底（`dsh-fs-sandbox` 按 sandbox mode 决定 writableRoots，
 * read-only 下为空，写操作直接改不了文件）；Claude Code 模式的文件工具来自 CLI 本身，**不经过**
 * DSH 的 fs/sandbox，所以这条限制必须在这里自己落地。
 *
 * 只列能静态识别的文件工具：`Bash` 里是否写文件无法静态判定，因此不在此列（见下面的能力边界）。
 *
 * 取自 `FILE_TOOL_WIRE_NAMES`（同一批工具正是宿主 pre-execute 要看见的那些），避免两处清单脱钩。
 */
const FILE_MUTATING_TOOLS = new Set(Object.keys(FILE_TOOL_WIRE_NAMES));

/**
 * 会执行任意命令的 Claude Code 工具。
 *
 * `Bash` 一条命令里既可能只是 `ls`，也可能写文件——**无法静态判定**。所以 read-only 下不能像
 * 文件工具那样「按名字判」，只能选一条明确的策略：
 *   - `deny`（默认，fail-closed）：read-only 下直接拒绝，不给审批口子。
 *   - `ask`：退回「批准一次就放行」（旧行为）。
 * 默认选 deny 的理由：standard 会话在 read-only 下由 DSH 文件沙箱兜底，无论怎么批准都改不了
 * 文件；Claude 的 Bash 没有那层沙箱，留审批口子等于把 read-only 降级成「点一下就能写」。
 * 代价是 read-only 会话里连只读命令也用不了——这是刻意换来的确定边界，改动需显式配置。
 *
 * **名字必须按平台给全**：CLI 在 Windows 上把 shell 工具报成 `PowerShell`（`system/init` 的工具表
 * 里没有 `Bash`），入参形状与 `Bash` 相同（`command`）。实机核验（2026-10-15，隔离 web 实例）
 * 抓到过这个缺口：只读会话里 `PowerShell` 的 `Set-Content -Path probe.txt …` 被送到审批 seam，
 * 点「允许一次」就能写——正是这条策略要堵的口子。漏一个名字就等于这条边界在该平台上不存在。
 *
 * `BashOutput` / `KillShell` 只读后台 shell 的输出/信号，不执行新命令，不在此列。
 */
const BASH_TOOLS = new Set(["Bash", "PowerShell"]);

/** read-only 下 `Bash` 的默认策略（见 BASH_TOOLS）。 */
export const DEFAULT_READ_ONLY_BASH = "deny";

/**
 * read-only 下**按工具名**能确定性给出的拒绝理由；`null` 表示这条策略不表态（不是「放行」）。
 *
 * 抽成一处是因为它有两个调用者：canUseTool 与 SDK 的 PreToolUse 钩子（见 makePreToolUseHook）。
 * 两个入口必须逐字同一条策略，否则「钩子拦得住、审批口子还在漏」这种半吊子状态没人会发现。
 *
 * @param {string} toolName CLI 报上来的工具名（**平台相关**，见 BASH_TOOLS）
 * @param {{ mode?: string, readOnlyBash?: string }} options 会话当前权限（现读）与该策略配置
 * @returns {string|null} 拒绝理由（直接作为 deny message / permissionDecisionReason）
 */
export function readOnlyDenial(toolName, { mode, readOnlyBash = DEFAULT_READ_ONLY_BASH } = {}) {
  if (mode !== "read-only") return null;
  if (FILE_MUTATING_TOOLS.has(toolName)) {
    return `dsh-claude-code: read-only file policy forbids ${toolName}; switch the session to workspace-write or danger-full-access before modifying files`;
  }
  if (BASH_TOOLS.has(toolName) && readOnlyBash !== "ask") {
    return `dsh-claude-code: read-only session denies ${toolName} because a shell command's file effects cannot be determined statically. ` +
      "Set engines.claude-code.readOnlyBash: \"ask\" to restore per-command approval, or switch the session to workspace-write / danger-full-access";
  }
  return null;
}

/**
 * SDK 的 PreToolUse 钩子：canUseTool 的补集。
 *
 * 为什么还需要第二个入口：canUseTool 只被 CLI **交上来**的调用触发。CLI 会把「它自己判定为
 * 只读」的命令直接放行，根本不问权限回调——实机核验（2026-10-15，隔离 web 实例）里只读会话的
 * `Get-ChildItem` 执行成功，`tool/call` 与 `tool/result` 之间**没有** `approval/asked`。按插件
 * 的分支反推（shell 工具若进了 canUseTool 必落到 ask 或 deny），那次回调根本没被调用。这类执行
 * canUseTool 看不见，只读边界对它们等于不存在（README 的「残余边界」一条说的就是这个）。
 *
 * 钩子对**每一次**工具调用都会触发（SDK 文档：「PreToolUse hook denies bypass canUseTool」），
 * 所以确定性拒绝在这里再挂一份，与 canUseTool 共用 `readOnlyDenial` 这一份策略。
 *
 * 钩子只做拒绝：不表态时返回 `{}`，CLI 继续走它自己的权限流程（含 canUseTool → 审批 seam）。
 * 权限状态每次现读，回合中切权限立即生效；会话读不到历史时 mode 为 undefined（readSessionEvents
 * 自身吞异常），此时钩子不表态——与 canUseTool 在同一情形下的表现一致，不会比它更宽。
 *
 * @param {object} options
 * @param {object} options.session 会话（供每次调用重读权限）
 * @param {string} [options.readOnlyBash] 同 makeCanUseTool
 * @returns {(input: object) => Promise<object>} HookCallback
 */
export function makePreToolUseHook({ session, readOnlyBash = DEFAULT_READ_ONLY_BASH } = {}) {
  return async function preToolUse(input) {
    if (input?.hook_event_name !== "PreToolUse") return {};
    const permission = readPermission(readSessionEvents(session));
    const message = readOnlyDenial(input.tool_name, { mode: permission.mode, readOnlyBash });
    if (!message) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } };
  };
}

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
 * @param {string} [options.readOnlyBash] read-only 下 `Bash` 的策略：`deny`（默认）/ `ask`；其它值一律按 `deny` 处理（fail-closed，拼错不会意外放宽）
 * @returns {(toolName: string, input: object, extra?: object) => Promise<object>} canUseTool 回调
 */
export function makeCanUseTool(ctx, { cwd, session, agent, allowedToolNames, goalToolNames = GOAL_TOOL_NAMES, readOnlyBash = DEFAULT_READ_ONLY_BASH, toolGate, planBridge, isLive } = {}) {
  const toolNames = allowedToolNames ?? goalToolNames;
  const live = () => { try { return isLive === undefined || isLive() === true; } catch { return false; } };
  const stopped = () => ({ behavior: "deny", message: "DSH tool permission query is closed or cancelled." });
  return async function canUseTool(toolName, input, { signal, title, displayName, blockedPath, decisionReason, toolUseID } = {}) {
    if (!live() || signal?.aborted) return stopped();
    // AskUserQuestion 是「向用户提问」这一交互本身，不是受权限门控的动作，所以必须**先于**
    // 任何策略短路处理：ask / no-prompt / danger-full-access 下都要送到 DSH 选择题 UI。
    // 顺序至关重要——若让下面的 bypass 短路先返回 allow，CLI 会把 allow 读成「用户已批准
    // 这次提问」，于是根本不弹窗（问题永远到不了用户眼前），工具在零答案下直接返回
    // 「The user did not answer the questions.」。实测：回合中途从 workspace-write 切到
    // Full access 后，紧接着的 AskUserQuestion 就是这样被吞掉的。
    if (toolName === "AskUserQuestion") return await bridgeAskUserQuestion(ctx, agent, input, signal);
    if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode") {
      try {
        return planBridge?.permission(toolName, toolUseID)
          ?? { behavior: "deny", message: "DSH native plan transitions require the Mod plan-review bridge; use /plan when unavailable." };
      } catch { return { behavior: "deny", message: "DSH plan-review permission is unavailable." }; }
    }

    // 宿主 `tools/pre-execute`：Claude 的文件工具在 CLI 进程内执行，不经过宿主的工具注册表，
    // 所以宿主的记录器（`dsh-workspace-changes` 的改动前整文件捕获）和钩子看不到它们；这里在
    // 放行之前补派发一次。位置与宿主一致——宿主的 monotonic guard 也排在 pre-execute 之后，
    // 因此插件的硬拒绝（read-only / approval policy）同样排在派发之后。
    // 非文件工具不派发，直接 allow；DSH 工具桥的工具也不在此列（它们本来就经过宿主注册表，
    // 再派发一次就是重复通知）。
    const call = { toolName, input, signal, callId: toolUseID };
    const gate = toolGate && !toolName.startsWith("mcp__") ? await toolGate.forPermission(call) : await dispatchHostToolGate(ctx, agent, call);
    if (!live() || signal?.aborted) return stopped();
    if (gate.kind === "deny") {
      return { behavior: "deny", message: `dsh-claude-code: host tool gate denied ${toolName}: ${gate.reason ?? "no reason given"}` };
    }
    if (gate.kind === "cancel") {
      return { behavior: "deny", message: `dsh-claude-code: host tool gate cancelled ${toolName}` };
    }
    // `ask` = 某个宿主监听器要求「先问人」。插件不静默吞掉这个要求，但不在这里弹窗：记下它，
    // 让下面所有自动放行的分支失效，最终落到 DSH 审批 seam（本插件里「问用户」的机制）。
    // 宿主的语义相同——`dsh-tools` 把 `ask` 交给审批服务，而不是自己放行。
    const hostAsked = gate.kind === "ask";
    const planDenied = planBridge?.guard?.(toolName, input);
    if (planDenied) return { behavior: "deny", message: planDenied };

    // 只放行当前查询精确点名的工具。goal 领域层核对 source / CAS；DSH 工具桥执行
    // 宿主自己的权限管线（job_kill 有副作用），不是通用 MCP 前缀自动许可。
    try {
      if (new Set(typeof toolNames === "function" ? toolNames() : toolNames).has(toolName)) return { behavior: "allow" };
    } catch { return { behavior: "deny", message: "DSH current tool allowlist is unavailable." }; }

    // 每次现读：回合中切 Full access / never 立即生效。
    const permission = readPermission(readSessionEvents(session));
    const strategy = permissionStrategy(permission);

    // danger-full-access：完全放行（提问以外的工具）。宿主监听器明确要求问人时不放行。
    if (strategy === "bypass" && !hostAsked) return { behavior: "allow" };

    // read-only：写文件一律拒绝，且**不得**退化成「批准一次就放行」——那等于 read-only 名存实亡
    // （standard 会话在 read-only 下无论怎么批准都改不了文件）。这是插件唯一能提供的执行边界，
    // 比 standard 的 OS 沙箱弱：它只覆盖能按名字静态识别的文件工具，不是操作系统级隔离。
    //
    // 这里与 SDK 的 PreToolUse 钩子共用 readOnlyDenial 这一份策略：CLI 对「自己判定为只读」的
    // 命令不调本回调，那条路径只有钩子看得见（见 makePreToolUseHook）。
    const readOnlyMessage = readOnlyDenial(toolName, { mode: permission.mode, readOnlyBash });
    if (readOnlyMessage) return { behavior: "deny", message: readOnlyMessage };

    // 只有 workspace-write 才有工作区写许可；read-only 和缺省模式不得靠路径绕过审批。
    if (permission.mode === "workspace-write" && !hostAsked && blockedPath && isWithinWorkspace(cwd, blockedPath)) {
      return { behavior: "allow" };
    }

    // no-prompt（approval policy = never）：不弹窗，区外一律拒绝。
    if (strategy === "no-prompt") {
      return { behavior: "deny", message: `dsh-claude-code: denied by approval policy (never) for tool ${toolName}` };
    }

    if (gate.approvedOnce === true) return { behavior: "allow" };

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
        hostAsked ? `host tool gate: ${gate.reason ?? "a host listener asked for approval"}` : "",
        decisionReason ?? title ?? displayName,
        blockedPath ? `path: ${blockedPath}` : "",
      ].filter(Boolean).join(" · ");
      const outcome = await approval.request({
        agent,
        toolName,
        ...(reason ? { reason } : {}),
        ...(signal ? { signal } : {}),
      });
      if (outcome !== "allowed-once") return { behavior: "deny", message: `dsh-claude-code: approval ${outcome}` };
      if (!live() || signal?.aborted) return stopped();
      const current = readPermission(readSessionEvents(session));
      const denied = readOnlyDenial(toolName, { mode: current.mode, readOnlyBash }) ?? planBridge?.guard?.(toolName, input);
      if (denied) return { behavior: "deny", message: denied };
      if (permissionStrategy(current) === "no-prompt") return { behavior: "deny", message: "dsh-claude-code: approval policy changed to never" };
      return { behavior: "allow" };
    } catch (error) {
      // 无开放回合 / 审计写入失败 / 应答者异常 → fail closed。
      return { behavior: "deny", message: String(error?.message ?? error) };
    }
  };
}
