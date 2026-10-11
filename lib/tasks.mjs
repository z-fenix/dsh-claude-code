// lib/tasks.mjs — Claude 原生任务工具（TodoWrite / TaskCreate / TaskUpdate）→ DSH 任务表回放。
//
// DSH 的任务列表面板读会话日志里的 "todo/write" 事件（@deepseek-ai/dsh-tool-todo 注册的
// session projection：整表替换、last-write-wins、turn/start 重置为 null）。Claude 引擎下
// 这些任务工具在 CLI 本地执行、不经过 DSH 工具层，所以由 claude-run.mjs 在流结算处把每个
// 原生任务操作回放进本表，并把变更后的全量快照交给调用方 append 成 todo/write 事件 ——
// 面板从任务创建那一刻起就能看到全部任务（含等待中）与各自状态。
//
// 实测（claude 2.1.296，stream-json）：
//   TaskCreate 入参 { subject }（没有 id），回执是纯文本 "Task #N created successfully: …"，
//   真实 id 只存在于回执里；TaskUpdate 入参 { taskId, status? / subject? }，且它的 tool_use
//   可能先于 TaskCreate 的回执到达 → 引用未绑定 id 的补丁先排队，回执绑定 id 后自动清算。

/** DSH 投影认可的 todo 状态。 */
const STATUSES = new Set(["pending", "in_progress", "completed"]);

/** todo_write 的两个名字：Claude 原名与 DSH wire 映射名（claude-run 收到的块是映射名）。 */
const TODO_WRITE_NAMES = new Set(["TodoWrite", "todo_write"]);

/**
 * 归一化 TodoWrite 的整表入参：trim 内容、丢弃空内容 / 非法状态 / 重复项。
 * 不做「至多一个 in_progress」校验 —— 那是 DSH 工具层的策略，Claude 允许并行任务，
 * 投影本身不校验，如实回放。非数组返回 null（无变更）。
 */
export function normalizeTodoInput(raw) {
  if (!Array.isArray(raw)) return null;
  const todos = [];
  const seen = new Set();
  for (const item of raw) {
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    const status = item?.status;
    if (content === "" || !STATUSES.has(status) || seen.has(content)) continue;
    seen.add(content);
    todos.push({ content, status });
  }
  return todos;
}

/** TaskCreate 入参 → 任务内容：subject 优先，content / description 兜底；没有可用内容返回 null。 */
function taskContent(input) {
  for (const key of ["subject", "content", "description"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** Claude tool_result 的 content（string | block[]）→ 用于 id 绑定的纯文本。 */
export function claudeToolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * 一个 DSH turn 的任务表。tracer 每回合新建一个实例，表生命周期与 DSH 面板的
 * 「turn/start 重置」天然对齐，无需跨回合持久化。
 */
export class ClaudeTaskTable {
  /** 表内项：{ id, content, status }；id 对面板不可见，只服务于 TaskUpdate 的引用。 */
  #items = [];
  /** 引用未绑定 id 的 TaskUpdate 补丁：{ taskId, patch }。 */
  #patches = [];
  /** TaskCreate 的 callId → 占位项引用（回执到达后绑定真实 id）。 */
  #placeholders = new Map();

  /**
   * 工具调用（tool_use）阶段应用一个原生任务操作。
   * @returns {Array|null} 变更后的全量任务表（数组，可能为空 = 清空）；无变更返回 null。
   */
  applyToolCall(name, input, callId) {
    if (TODO_WRITE_NAMES.has(name)) return this.#replaceWith(normalizeTodoInput(input?.todos));
    if (name === "TaskCreate") return this.#create(input, callId);
    if (name === "TaskUpdate") return this.#update(input);
    return null;
  }

  /**
   * 工具回执阶段：TaskCreate 的回执带真实 id（"Task #N created successfully: …"），
   * 绑定该 callId 的占位项；若绑定让排队的补丁生效，返回生效后的快照，否则 null。
   */
  applyToolResult(name, callId, resultText) {
    if (name !== "TaskCreate") return null;
    const placeholders = this.#placeholders.get(callId);
    if (placeholders === undefined || placeholders.length === 0) return null;
    this.#placeholders.delete(callId);
    const match = typeof resultText === "string" ? resultText.match(/Task #(\d+) created/) : null;
    const baseId = match === null ? null : Number(match[1]);
    placeholders.forEach((item, index) => {
      item.id = baseId === null ? `${item.id}#${index}` : String(baseId + index);
    });
    return this.#drainPatches();
  }

  /** 当前任务表；空表返回 null（调用方据此不写事件）。 */
  snapshot() {
    return this.#items.length === 0 ? null : this.#list();
  }

  #list() {
    return this.#items.map(({ content, status }) => ({ content, status }));
  }

  /** TodoWrite 的整表替换：占位项与排队补丁随旧表一起作废。id 用 todo: 前缀命名空间，
   * 与 TaskCreate 回执的纯数字 id（CLI 任务系统的 id）隔离，避免 TaskUpdate 误命中列表项。 */
  #replaceWith(todos) {
    if (todos === null) return null;
    this.#items = todos.map((todo, index) => ({ id: `todo:${index}`, ...todo }));
    this.#patches = [];
    this.#placeholders.clear();
    return this.#list();
  }

  #create(input, callId) {
    const entries = Array.isArray(input?.tasks) ? input.tasks : [input];
    const created = [];
    for (const entry of entries) {
      const content = taskContent(entry);
      if (content === null) continue;
      const item = { id: `pending:${String(callId ?? "")}:${created.length}`, content, status: "pending" };
      this.#items.push(item);
      created.push(item);
    }
    if (created.length === 0) return null;
    if (typeof callId === "string" && callId !== "") this.#placeholders.set(callId, created);
    return this.#list();
  }

  #update(input) {
    if (!input || input.taskId == null) return null;
    const patch = {};
    if (typeof input.status === "string") patch.status = input.status;
    if (typeof input.subject === "string" && input.subject.trim() !== "") patch.content = input.subject.trim();
    if (patch.status === undefined && patch.content === undefined) return null;
    const taskId = String(input.taskId);
    if (this.#applyPatch(taskId, patch)) return this.#list();
    // 引用的 id 还没绑定（TaskUpdate 的 tool_use 先于 TaskCreate 回执到达）→ 排队。
    this.#patches.push({ taskId, patch });
    return null;
  }

  /** 把一个补丁应用到表内；返回是否命中（未命中不改表）。 */
  #applyPatch(taskId, patch) {
    const index = this.#items.findIndex((item) => item.id === taskId);
    if (index === -1) return false;
    if (patch.status === "deleted") {
      this.#items.splice(index, 1);
    } else {
      const item = this.#items[index];
      if (patch.status !== undefined && STATUSES.has(patch.status)) item.status = patch.status;
      if (patch.content !== undefined) item.content = patch.content;
    }
    return true;
  }

  /** 清算排队补丁；有生效返回快照，否则 null（仍未命中的补丁继续排队）。 */
  #drainPatches() {
    let changed = false;
    this.#patches = this.#patches.filter((queued) => {
      if (this.#applyPatch(queued.taskId, queued.patch)) {
        changed = true;
        return false;
      }
      return true;
    });
    return changed ? this.#list() : null;
  }
}
