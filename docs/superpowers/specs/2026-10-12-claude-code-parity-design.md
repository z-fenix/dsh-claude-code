# Claude Code 交互与桥接兼容设计

本设计对应用户已批准的 `abstract-discovering-glade.md`；批准范围是安全前置与第一期，后续标准能力按独立任务验收。不修改 DSH app.asar，不安装全局 Claude 插件，不自动 commit/push，不运行未经批准的收费推理。

## 目标与确认项

- 截图为 standard 模式参考，改进当前插件列表而不改 standard UI。
- 普通 followup 排队；steer 在安全边界插入；inject 不自己启动新的人类回合；显式 cancel 停止当前生成，keepInbox 保留待办。
- 模型输入与持久化事实一致；不因已提交但尚未消费的输入提升 goal 的人类权威。
- 子代理列表使用短任务 label 和简洁的来源/类型标题，one-shot 与 running/idle 如实上报。累计 token 不伪装成上下文占用。新标题使用 provider 来源，不伪造用户手动重命名。
- mods 可作为 prompt/工具适配器，但目标权威、会话写入、权限与 CAS 留在 DSH。现有 MCP 为默认兼容后备；每个查询只暴露一套 goal 工具。
- 系统提示词来自可信 prompt.compose sections，不从 assistant 自述或 system/init 推断。观察快照、已知配置和真正完整捕获分别标识。

## 边界

### 安全前置

mode 与 approval policy 独立；read-only 不因工作区 blockedPath 自动放行写调用。只修回调不代表接入 DSH OS 沙箱。无法保证限制的执行能力必须拒绝/明确不支持，不默默降级。

### 运行中输入

一份活查询句柄对应一份 epoch 和可关闭 async 输入流；所有投递串行。复用 DshInbox 的持久化事实和 buildPrompt 图片投影。消息按稳定 id/SDK uuid 建立 reserved、submitted、observed、canceled、uncertain 台账，启动/构造前不破坏性移除待办。

提交成功不代表模型消费。工具调用的 goal 权威依据已确认消费的 source，而非所有已排队输入。无法确定已提交消息是否消费时明确 uncertain，不自动重放。取消优先 interrupt，只有失败/退出/dispose 使用硬关闭；不假定 interrupt 会清空 SDK 队列，依据能力和 receipt 处理。

一个 SDK result 不是整条 query 结束。保留后台子代理续跑；错误 result、日志拒写、旧 epoch 回调、请求终止都有明确终态。tool/call 在 step/end 前成对收尾，turn-stopping 先于 turn/end。旧句柄不影响新运行。

### 子代理列表

清洗任务 label：折叠空白、去控制序列、按 Unicode 安全长度截断；空 description 继续尝试 subagent_type/name。标题简要表明 Claude 来源及子代理类型，避免重复长任务/角色说明；提供合法 session/title provider 事件。保持 descriptor/catalog 的 one-shot 和被动载体机制；不重写已落盘历史，不覆盖用户后续手动标题。

### mods 与宿主桥

mod 无 Node/DOM，通过 `$` 接口调用本机受限服务。服务仅 loopback、随机短期令牌，绑定 agent/session/epoch；限定请求类型和工具列表，拒绝未知方法、过大请求、错归属、重放和超时。关闭查询同时撤销令牌和通道。禁止任意宿主方法入口，禁止跨会话借用权限。

本机 CLI 2.1.296 有文档依据支持 SDK host 加载 mods；实际 executable 仍先验证。mod 随 npm 包发布，仅给该 Claude 子进程加载，不改全局 settings。未支持 mod 的部署保持现有 MCP；降级须可见。

goal 使用共享领域处理器；MCP 与 mod 的工具名、权限白名单各自精确匹配，不放行整个前缀。mod 不接收可自报 human/goal 权威字段。revision 和 goal round 校验不变。

### 系统提示词

捕获 next(e) 返回的有序 `{id,text,scope}` sections，不改 prompt，不打乱 shared/session cache 边界。标记 observed-compose 及捕获点；其他 mods 可能在外层继续改写，未证明完整性时不能称最终全文。

优先保存专有 snapshot 事件；写入原生 system/message 时，必须在合法 open step 内协调首 user/message 记录顺序，使真实捕获在模型请求前持久化。request/header 不写 system。无法满足日志/surface 契约时显示快照/未知，而非倒插历史或伪造全量。

## 后续路标（不混入第一期）

第二期：真实沙箱路由、fork 历史继承、模型/推理配置、实际 Claude compact。
第三期：skills/persona/runtime/present/jobs/动态工具、可选 MCP 资源、continuable 子代理/workflow、工具结果 meta/image、非 Git 捕获、真实 context 分项与进度。

## 验收

- fake SDK + 确定性屏障覆盖并发、取消、重复 id、启动失败、uncertain、旧 epoch；不依赖 sleep。
- 混合 human/goal、过期 revision、未消费输入不能提权；两种 goal adapter 对同样输入输出一致。
- CLI plugin validate/plugin test 与无推理兼容检查；未证实的能力不宣称通过。
- 真实 DSH v4 事件校验、持久化重开、流式无翻倍、工具生命周期完整。
- 完整 pnpm test，桌面/收费 CLI 验证单独确认范围与预算。
