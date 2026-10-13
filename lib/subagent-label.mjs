// 子代理列表的短任务名与来源标题；不从角色 prompt 猜测任务，不改变真实模式/用量。
const OSC = /(?:\u001b\]|\u009d)(?:(?!\u0007|\u001b\\)[\s\S])*(?:\u0007|\u001b\\|$)/gu;
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\p{Cf}/gu;

function clean(value) {
  return typeof value === "string"
    ? value.replace(OSC, "").replace(CSI, "").replace(/\u001b[@-_]/gu, "")
      .replace(CONTROLS, (char) => [0x200c, 0x200d].includes(char.codePointAt(0)) ? char : "")
      .replace(/\s+/gu, " ").trim()
    : "";
}

function short(value, limit) {
  const chars = [...value];
  return chars.length <= limit ? value : chars.slice(0, limit - 1).join("").trimEnd() + "…";
}

export function subagentDisplay(input = {}) {
  const kind = clean(input?.subagent_type) || "子代理";
  const task = clean(input?.description) || clean(input?.subagent_type) || clean(input?.name) || "子代理";
  return { label: short(task, 48), title: short(`Claude Code · ${kind}`, 48) };
}
