// test/cordis.patch.test.mjs — 校验随包发布的 cordis.patch.yml。
//
// 这个文件是插件「装上就能用」的关键：它声明两个 Loader 行——
//   1. `dsh-claude-code`（插件本体，config 走 Config schema）
//   2. `preset-claude-code`（@deepseek-ai/dsh-agent-preset 声明行，决定预设出现在列表里）
// 行写错不会有编译错误，只会在桌面端表现为「预设列表里什么都没有」，所以这里按最严格的
// 口径逐条核对：YAML 可解析、结构是 `- insert: [...]`、行有 name、preset 声明满足
// dsh-agent-preset 的 Config schema（id 必填、plugins 必填且是数组）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const patchPath = fileURLToPath(new URL("../cordis.patch.yml", import.meta.url));

// `!!js <表达式>` 是宿主 loader 的自定义标量标签（`dsh-web-app` 自带的
// presets/standard.patch.yml 也用它，例如按平台 disabled）。js-yaml 默认不认识它，
// 会直接抛 unknown tag，所以这里注册一个同名类型：测试只需读到表达式原文，
// 不做求值（求值是宿主的事）。
const jsTagType = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: (value) => typeof value === "string",
  construct: (value) => value,
});
const patchSchema = yaml.DEFAULT_SCHEMA.extend([jsTagType]);

const patch = yaml.load(readFileSync(patchPath, "utf8"), { schema: patchSchema });

/** 把 patch 层里所有 insert 行摊平成一个列表。 */
function insertedRows(layers) {
  const rows = [];
  for (const layer of layers ?? []) {
    for (const row of layer?.insert ?? []) rows.push(row);
  }
  return rows;
}

test("patch 是顶层数组，且只包含 insert 层", () => {
  assert.ok(Array.isArray(patch), "cordis.patch.yml 必须是顶层数组");
  assert.ok(patch.length > 0);
  for (const layer of patch) {
    assert.ok(layer && typeof layer === "object" && !Array.isArray(layer), "每个 patch 层必须是映射");
    assert.deepEqual(Object.keys(layer), ["insert"], `未知的 patch 键：${Object.keys(layer).join(",")}`);
  }
});

test("每一条插入行都有 id 与 name", () => {
  const rows = insertedRows(patch);
  assert.ok(rows.length >= 2, "至少要插入插件行与预设声明行");
  for (const row of rows) {
    assert.equal(typeof row.id, "string", "行必须有 id");
    assert.ok(row.id.length > 0);
    assert.equal(typeof row.name, "string", `行 ${row.id} 必须有 name`);
    assert.ok(row.name.length > 0);
  }
});

test("插件行的 config 覆盖本插件的 Config 字段", () => {
  const row = insertedRows(patch).find((candidate) => candidate.name === "dsh-claude-code");
  assert.ok(row, "必须插入 dsh-claude-code 插件行");
  const config = row.config ?? {};
  assert.equal(config.enabled, true);
  assert.equal(config.defaultEngine, "deepseek", "默认引擎必须是 deepseek 哨兵，未选预设的会话才走原生循环");
  assert.deepEqual(config.engineByPreset, {});
  const engine = config.engines?.["claude-code"];
  assert.ok(engine, "必须给出 claude-code 引擎的默认配置");
  assert.equal(engine.executable, "claude");
  assert.equal(engine.persistSession, true);
  assert.equal(engine.includePartialMessages, true);
  assert.equal(engine.traceSubagents, true);
  assert.deepEqual(engine.env, {});
});

test("预设声明行满足 @deepseek-ai/dsh-agent-preset 的 Config schema", () => {
  const row = insertedRows(patch).find((candidate) => candidate.name === "@deepseek-ai/dsh-agent-preset");
  assert.ok(row, "必须插入 @deepseek-ai/dsh-agent-preset 声明行");
  const config = row.config ?? {};
  assert.equal(typeof config.id, "string");
  assert.equal(config.id, "claude-code", "预设 id 必须与引擎 id 相同（by-id 路由的锚点）");
  assert.equal(typeof config.name, "string");
  assert.equal(typeof config.description, "string");
  assert.equal(typeof config.order, "number");
  assert.ok(Array.isArray(config.plugins), "plugins 必填且必须是数组");
});

test("预设构成必须带完整工具目录，不能只有 persona", () => {
  const row = insertedRows(patch).find((candidate) => candidate.name === "@deepseek-ai/dsh-agent-preset");
  const plugins = row.config.plugins;

  // 回归护栏：历史上这个预设只声明了 persona 行，导致选中它的会话工具目录塌成
  // 「只有 load_workspace_dependencies」，模型只能回答「我无法读取文件」。
  // 预设的 plugins 列表就是该会话的工具目录来源，所以这里按「必须有工具行」来断言。
  assert.ok(plugins.length > 5, `预设必须声明完整工具目录，当前只有 ${plugins.length} 行`);

  const names = plugins.map((plugin) => plugin.name);
  for (const required of [
    "@deepseek-ai/dsh-tool-fs",          // read / write / edit
    "@deepseek-ai/dsh-tool-fs-search",   // glob / grep
    "@deepseek-ai/dsh-tool-todo",
    "@deepseek-ai/dsh-tool-ask-user",
    "@deepseek-ai/dsh-tool-web",
  ]) {
    assert.ok(names.includes(required), `工具目录缺少 ${required}`);
  }
  // 平台互斥的 shell 行必须都在，靠 disabled 表达式二选一。
  assert.ok(names.includes("@deepseek-ai/dsh-tool-bash") && names.includes("@deepseek-ai/dsh-tool-pwsh"),
    "必须同时声明 bash 与 pwsh 行（按平台 disabled）");
});

// 回归护栏：预设**不得**声明 host plane 已经注册的委派工具。
//
// 实测故障：预设照搬 standard 预设声明了 tool-subagent（toolName: subagent）等委派行，
// 而 @deepseek-ai/dsh-base 已在 host plane 注册了这些行，在同时存在其它委派工具来源的
// 部署里（如 experimental agent-team）就会撞名：
//   failed to create session "…": Error: tool "subagent" is already registered in this scope
// 后果是**所有会话都创建不出来**。@deepseek-ai/dsh-tools 的 tools.register() 是
// 先全局、后 agent 作用域，同层同名直接抛错——所以预设只该声明 host plane 没有的东西。
test("预设不得重复声明 host plane 已注册的委派工具", () => {
  const row = insertedRows(patch).find((candidate) => candidate.name === "@deepseek-ai/dsh-agent-preset");
  const ids = [];
  const walk = (list) => {
    for (const plugin of list ?? []) {
      if (plugin.id !== undefined) ids.push(plugin.id);
      if (Array.isArray(plugin.config)) walk(plugin.config);
    }
  };
  walk(row.config.plugins);

  for (const forbidden of [
    "delegation",
    "tool-subagent",
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-subagent-fork",
    "workflow-ptc",
    "tool-workflow",
    "tool-ralph",
  ]) {
    assert.ok(!ids.includes(forbidden),
      `预设不得声明 ${forbidden}：它已由 dsh-base 的 host plane 注册，重复声明会导致 tool "subagent" is already registered in this scope，所有会话创建失败`);
  }
});

/** 探测宿主 app.asar：DSH_ASAR 环境变量优先，其次已知安装位置；找不到返回 undefined。 */
function locateHostAsar() {
  const candidates = [
    process.env.DSH_ASAR,
    "C:\\software\\DeepSeek Harness\\resources\\app.asar",
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  return candidates.find((candidate) => existsSync(candidate));
}

/** 从宿主 app.asar 的头部列出运行时自带的包名（只读头部，不加载整个归档）。 */
function runtimePackageNames(asarPath) {
  const fd = readFileSync(asarPath, { flag: "r" });
  const headerPickleSize = fd.readUInt32LE(4);
  const headerJsonSize = fd.readUInt32LE(12);
  const header = JSON.parse(fd.subarray(16, 16 + headerJsonSize).toString("utf8"));
  const names = new Set();
  const scopeRoot = header.files?.dsh?.files?.node_modules?.files?.["@deepseek-ai"]?.files ?? {};
  for (const name of Object.keys(scopeRoot)) names.add(`@deepseek-ai/${name}`);
  return names;
}

test("preset 的每一行都有 id 与 name，且模块名可被解析", (t) => {
  const row = insertedRows(patch).find((candidate) => candidate.name === "@deepseek-ai/dsh-agent-preset");
  /** 递归收集所有插件行的模块名。 */
  const collect = (list, out = []) => {
    for (const plugin of list ?? []) {
      out.push(plugin.name);
      if (Array.isArray(plugin.config)) collect(plugin.config, out);
    }
    return out;
  };
  const moduleNames = collect(row.config.plugins).filter((name) => name !== "cordis:group");
  assert.ok(moduleNames.length > 0);

  // 宿主 asar 的位置因机器而异（本仓库作者与用户没有共同的默认安装盘符），所以先探测：
  // DSH_ASAR 环境变量优先，其次已知安装位置。找不到宿主时跳过整个校验——预设引用的包
  // 允许只存在于宿主运行时，没有运行时清单就无法证明「不存在」，报错只会是假阳性。
  const host = locateHostAsar();
  if (host === undefined) {
    t.skip("未找到宿主 app.asar（可用 DSH_ASAR 环境变量指向宿主的 resources/app.asar），跳过包名解析校验");
    return;
  }
  const runtime = runtimePackageNames(host);

  for (const name of moduleNames) {
    // 允许带子路径（如 tool-subagent-control/list-agents），取前两段作包名。
    const parts = name.split("/");
    const pkg = name.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const local = fileURLToPath(new URL(`../node_modules/${pkg}/package.json`, import.meta.url));
    const inWorkspace = existsSync(local);
    const inRuntime = runtime.has(pkg);
    assert.ok(
      inWorkspace || inRuntime,
      `预设引用了不存在的包：${name}（workspace 与宿主运行时都没有）`,
    );
  }
});

test("组内必填 config 不许省略（plan-mode.section 回归）", () => {
  const row = insertedRows(patch).find((candidate) => candidate.name === "@deepseek-ai/dsh-agent-preset");

  /** 递归按 id 找一行。 */
  const find = (list, id) => {
    for (const plugin of list ?? []) {
      if (plugin.id === id) return plugin;
      if (Array.isArray(plugin.config)) {
        const hit = find(plugin.config, id);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };

  // 历史故障：精简预设时把 plan-mode 的 config 写成空，`dsh-plan-mode` 的
  // `PlanModeConfig` 要求非空 `section`，于是**所有引用该预设的会话都无法创建/恢复**，
  // 报 `PlanModeConfig needs a non-empty 'section'`。
  const planMode = find(row.config.plugins, "plan-mode");
  assert.ok(planMode, "预设必须声明 plan-mode 行");
  assert.equal(typeof planMode.config?.section, "string", "plan-mode.config.section 必填");
  assert.ok(planMode.config.section.trim().length > 100, "section 不能是占位空串");
  assert.match(planMode.config.section, /plan mode/i);

  // 其余组内行若带了 config，也不能是空对象（空对象同样可能触发必填校验）。
  const walk = (list) => {
    for (const plugin of list ?? []) {
      if (Array.isArray(plugin.config)) {
        walk(plugin.config);
      } else if (plugin.config !== undefined && plugin.id !== undefined
        && Object.keys(plugin.config).length === 0 && plugin.name !== "cordis:group") {
        assert.fail(`行 ${plugin.id} 带了空 config，应删除该键或补齐必填字段`);
      }
    }
  };
  walk(row.config.plugins);
});

test("persona 行字段对齐 0.2.0-rc.2 的 dsh-persona schema", () => {
  const row = insertedRows(patch).find((candidate) => candidate.name === "@deepseek-ai/dsh-agent-preset");
  const persona = row.config.plugins.find((plugin) => plugin.id === "persona");
  assert.ok(persona, "预设必须有一行 persona");
  assert.equal(persona.name, "@deepseek-ai/dsh-persona");
  assert.equal(typeof persona.config.prefix, "string");
  assert.ok(persona.config.prefix.length > 0);
  // 人设必须承认自己是工作区里能干活的 agent，否则模型会声称没有工具。
  assert.match(persona.config.prefix, /Claude Code/);
  // 旧字段名（0.1.0-rc.x 的 persona）不允许出现：0.2.0-rc.2 的 schema 会拒绝它。
  assert.equal(persona.config.text, undefined);
});

test("引擎 id 与预设 id 一致，router 才能 by-id 命中", () => {
  const rows = insertedRows(patch);
  const preset = rows.find((candidate) => candidate.name === "@deepseek-ai/dsh-agent-preset");
  const engineConfig = rows.find((candidate) => candidate.name === "dsh-claude-code").config.engines;
  assert.ok(Object.hasOwn(engineConfig, preset.config.id));
});
