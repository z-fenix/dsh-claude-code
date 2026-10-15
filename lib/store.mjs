// lib/store.mjs — 跨进程持久化「DSH 会话 → Claude Code 会话 id」的映射。
//
// DSH session header 是白名单 schema，塞不进自定义字段，故用插件自持的 JSON 旁路存储。
// 有了它，进程重启后续聊能接回同一个 Claude 会话（而不是重放历史）。
// 写入串行化，避免并发丢更新；写失败静默（不能因为写盘失败打断一个回合）。
//
// **这张表不是唯一来源**：同一次捕获还会写一条 `claude-code/session` 私有事实（fsync、
// 按会话分文件）。本表是「整文件覆盖 + 失败静默」，一次瞬时写失败或一次半截文件就能丢掉
// 全部会话的映射；私有事实是每会话一条、同步落盘，所以 `load` 在表里查不到时回落到它。
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readJournalRecords } from "./plugin-facts.mjs";

/** 存储文件路径；可用 `DSH_CLAUDE_CODE_STORE` 覆盖根目录（默认 `~/.dsh/dsh-claude-code`）。 */
function storePath() {
  const root = process.env.DSH_CLAUDE_CODE_STORE ?? join(homedir(), ".dsh", "dsh-claude-code");
  return join(root, "sessions.json");
}

/** 读整个映射表；文件缺失或损坏时返回空表。 */
async function readAll() {
  try {
    const parsed = JSON.parse(await readFile(storePath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 旁路表的兜底：从该会话的私有事实里取最后一条 `claude-code/session`。
 *
 * 日志缺失、损坏、身份对不上时 `readJournalRecords` 返回 undefined，这里一并当「没有记录」——
 * 恢复路径宁可新建一个 Claude 会话（失忆），也不猜着接一个不属于本会话的 id。
 */
function loadFromJournal(sessionId) {
  const records = readJournalRecords(sessionId);
  if (!Array.isArray(records)) return undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.type !== "claude-code/session") continue;
    const value = records[index].data?.claudeSessionId;
    return typeof value === "string" && value !== "" ? value : undefined;
  }
  return undefined;
}

/**
 * 读某个 DSH 会话对应的 Claude Code 会话 id。
 * @param {string} sessionId
 * @returns {Promise<string|undefined>}
 */
export async function load(sessionId) {
  const value = (await readAll())[sessionId];
  if (typeof value === "string" && value !== "") return value;
  return loadFromJournal(sessionId);
}

let writeChain = Promise.resolve();

/**
 * 记录某个 DSH 会话对应的 Claude Code 会话 id（原子替换写入）。
 * @returns {Promise<void>} 串行队列的尾部；失败已吞掉
 */
export function save(sessionId, claudeSessionId) {
  if (typeof claudeSessionId !== "string" || claudeSessionId === "") return Promise.resolve();
  writeChain = writeChain
    .then(async () => {
      const file = storePath();
      const all = await readAll();
      all[sessionId] = claudeSessionId;
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
      await rename(tmp, file);
    })
    .catch(() => {
      // 写盘失败只影响「跨进程精确续接」，不影响当前回合；静默降级为下一轮重放。
    });
  return writeChain;
}
