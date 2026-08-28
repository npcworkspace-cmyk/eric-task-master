# Eric Task Master

[English](./README.md) | [简体中文](./README.zh-CN.md)

**为 AI Agent 打造的持久化浏览器自动化任务系统。**

版本：**2.5.4**

AI Agent 已经能够理解需求、制定计划和编写代码，但浏览器执行往往仍是最薄弱的一环。Agent 内置浏览器适合短时交互，却很难稳定保留登录态、任务上下文和恢复现场；简单的 CDP 控制器虽然能快速操作真实浏览器，却会迫使每个 Agent 为每次任务重新编写控制器、进度跟踪、异常恢复和清理逻辑。

Eric Task Master 正是为解决这个缺口而开发。它以 Playwright 为执行核心，把网页操作变成持久、隔离、可观察、可恢复的任务。Agent 可以启动一个持续数小时的工作，暂时离开后重新接管，通过检查点继续，读取可验证的结果，并确认所有任务窗口已经关闭，而不占用或打扰用户的日常浏览器，也不需要反复消耗 Token 去重新理解同一套控制机制。

`AI Agent` · `浏览器自动化` · `Playwright` · `MCP Server` · `Web Automation` · `Computer Use` · `工作流自动化` · `Browser Agent` · `Headless Browser` · `多 Agent 自动化`

## Agent 可以用它构建什么？

Task Master 是通用执行基座，不是某一个网站的专用机器人。搭配 Agent、专项 Skill 或 Task Pack，可以用于：

- 无人值守的网页研究、信息监测和带来源的数据采集；
- 跨越数百个页面的长时间批量任务，不必持续占用一个 Agent 回合；
- 使用独立持久化 Profile 完成需要登录态的后台、门户、CMS、CRM 和账号工作；
- 使用隐身临时 Profile 完成不需要登录、任务结束即销毁的干净任务；
- 可信本机内的多个 Agent 共享受控 Profile 目录，并通过不同活动 Profile 并行工作；同一 Profile 自动排队，任务仍清楚归属；
- 由 Agent、定时器或业务系统触发的日常重复工作流；
- 浏览器 QA、内容核验、表单处理、文件上传下载和证据留存；
- 进一步封装成销售线索、电商运营、媒体研究、供应商研究、客服、合规检查或内部 RPA 等生产级 Task Pack。

这些是可组合的应用方向，不代表内置了所有网站权限，也不代表任何网站都能无条件自动化。Task Master 负责稳定的浏览器执行；专项 Skill 或 Task Pack 负责业务逻辑、平台规则、解析方式、检查点、结果格式和完成证据。

## 为什么不直接使用 Agent 内置浏览器或临时 CDP 脚本？

| 方式 | 优势 | 通常欠缺的部分 |
| --- | --- | --- |
| Agent 内置浏览器 | 临时浏览和短时交互方便 | 持久任务、登录 Profile、长任务恢复、可信本机 Agent 作用域、清理证明 |
| 一次性 CDP 控制器 | 原始控制快、灵活 | 稳定生命周期、队列、进度、检查点、证据、恢复和可复用任务契约 |
| Eric Task Master | 面向生产形态的浏览器任务 | 网站与行业知识，由 Skill 和 Task Pack 按需叠加 |

Task Master 不替代 Agent 的思考能力，而是给 Agent 一双长期稳定、不会轻易失联的浏览器“手”。

## 三层模型

1. **Task Master 运行时**：纯 Playwright 执行、持久化与临时 Profile、任务队列、进度、恢复、证据、清理，以及统一负责可见网页交互的 Human Journey 引擎。
2. **Owner Console 人类工作台**：一个固定本地网址，只做共享 Profile 管理、任务进度查看，以及暂停、恢复、取消和删除记录；用户直接在隔离的 Playwright 持久 Profile 中登录。
3. **MCP + Skills + Task Packs**：Agent 只接触精简的高级任务接口，行业和网站能力独立叠加，不污染核心。

这样可以用一个稳定的万能基座，持续定义不同的专属批量行动助手。

## 给新 Agent：唯一固定启动协议

当用户把 GitHub 链接交给你时，必须按以下顺序执行。不要另外发明 daemon、端口、浏览器启动器、控制器或任务轮询脚本。

> 完整 GitHub 仓库才是运行时。GitHub Release 中，`eric-task-master-vX.Y.Z.zip` 是可运行的完整项目，`eric-task-master-skill-vX.Y.Z.zip` 只是可选的 Agent 指令适配层，不能单独运行；`SHA256SUMS` 用于校验两个压缩包。请拉取对应标签或下载完整项目 ZIP，不要把 Skill ZIP 当成运行时。

1. 如果仓库是私有的，先确认当前环境拥有 GitHub 访问权限，然后拉取完整仓库。
2. 确认 Node.js 版本不低于 20。
3. 阅读 `skills/eric-task-master/SKILL.md`。宿主支持 Skill 时安装这个目录；不支持时就在仓库中原地遵循它。
4. 在项目根目录只运行：

   ```bash
   node scripts/taskmaster.mjs connect --json
   ```

5. `connect` 会安装锁定依赖和匹配的 Playwright Chromium；在旧 Manager 空闲时完成可信的优雅升级；启动本地 Manager；执行真实浏览器验收；并注册已支持的 MCP 宿主。如果旧 Manager 还有任务，升级会停止且不会打断原任务。直接读取顶层 `state` 与 `readyForTasks`：一旦是 `agent_host_reload_required`，必须停止发送任务，保持 Manager 运行，重载当前 Agent 宿主一次，再原样执行同一条命令。
6. 严格执行返回的 `blockingAction` 或 `nextAction`。修复明确前置条件后，最多原样重试同一条命令一次；不要发散成另一套临时控制器。需要集中诊断时只运行 `node scripts/taskmaster.mjs doctor --json`；它会汇总 Manager、MCP 注册和近期脱敏错误，不会启动第二套 Manager 或浏览器。
7. 首次打开返回的 Owner Console 链接。页面会静默建立持久本机会话，不需要输入授权码，也没有 Agent 绑定流程；以后直接收藏 `http://127.0.0.1:19946/dashboard`。
8. MCP 是默认 Agent 路径。任何 `registered_pending_*` 结果都只完成一次返回中指定的审批或重载，然后用 `taskmaster_status` 与 `taskmaster_profiles_list` 验证真实宿主连接。
9. 二选一并在本次任务中保持同一路径：
   - 宿主已经加载 MCP 时，依次调用 `taskmaster_status`、`taskmaster_profiles_list`；
   - 仅当返回 `adapter_pending`、`extension_required`，或本轮无法重载宿主时，在完整项目根目录使用固定 CLI 兜底，并在所有作用域命令中保持同一个、与其他 Agent 不同的身份：

     ```bash
     node scripts/taskmaster.mjs status --agent-id STABLE_ID --agent-name AGENT_NAME --json
     node scripts/taskmaster.mjs profiles list --agent-id STABLE_ID --agent-name AGENT_NAME --json
     ```

10. 状态和 Profile 检查成功后，再询问用户要执行什么浏览器任务。一次任务中不要混用 MCP 与 CLI 身份。

可以直接复制给新 Agent：

> 安装并启动 `https://github.com/npcworkspace-cmyk/eric-task-master`。拉取完整仓库，阅读或安装 `skills/eric-task-master`，只运行 `node scripts/taskmaster.mjs connect --json`，不要发明其他控制器或端口。默认走 MCP；仅在 `adapter_pending`、`extension_required` 或本轮宿主无法重载时，严格按 Skill 使用稳定身份的 CLI 兜底。返回 Owner Console 链接；真实状态和 Profile 检查成功后，询问我要执行什么任务。

## 日常使用

首次启动完成以后，用户只需要自然描述任务，例如：

> 使用 Eric Task Master，创建隐身临时 Profile，以 auto 模式研究这些网站，定时反馈进度，保存结果证据，任务结束后关闭所有窗口。

Agent 随后只走一条持久任务路径：发现任务类型、使用幂等键提交一次、保存任务 ID、持续等待或重新接管同一个 ID、在需要关注时读取诊断信息，并且只在证据和清理全部通过后宣布完成。

连接与任务错误保持机器可读：旧 Agent bridge 会在进入任务路由前被明确拦截，只返回一次宿主重载动作；任务输入错误会保留具体失败字段、安全详情和请求 ID，不再被包装成泛化的 Manager 拒绝。

每次启动任务都会返回一个聚焦到该任务的 Owner Console 链接。首次链接静默建立本地 Owner Cookie，之后可以直接访问已收藏的固定地址。用户说“启动任务面板”时，使用 MCP `taskmaster_dashboard_open`，或者使用 CLI `node scripts/taskmaster.mjs dashboard-open [TASK_ID] --agent-id STABLE_ID --agent-name AGENT_NAME --json`，再把链接返回给用户。Task Master 不会擅自拉起系统浏览器。

### Profile

- **persistent**：适合登录态和重复账号工作；从 Dashboard 打开后，直接在该 Playwright 窗口中登录；
- **ephemeral / 隐身临时**：每个无登录任务都使用全新非持久浏览器，清理后销毁。

新建持久 Profile 默认使用本机稳定版 Chrome 和 `human`；新建临时 Profile 默认使用项目锁定的 Chromium 和 `auto`。所有 Profile 都可选择 `fast`、`auto` 或 `human`。任务运行中切换时，Worker 确认应用后会在下一个调度或运动分段立即生效，不需要重启任务。Engine 创建后不可变，也不会自动回退。人工打开持久 Profile 时浏览器始终可见；`headless` 只影响任务运行。

### 行为模式

- **fast**：保留完整可见动作，只压缩节奏；鼠标与滚动仍连续，逐字输入仍有非零间隔，适合确定性操作和批量数据任务；
- **human**：使用同一套完整动作，根据距离、目标大小和浏览阶段自然分配快慢；
- **auto**：自动平衡速度与谨慎程度；遇到动态页面、遮挡、超时、导航不确定、动作失败或限流时加深拟人节奏，恢复后重新提速。

拟人节奏是提高交互可靠性的策略，不是指纹伪装，不代表绕过网站控制，也不承诺保护账号免受平台规则影响。
三档都执行同一套最小加加速度鼠标轨迹、一次连续的长距离接近与目标附近精确减速、目标内点击、显式逐字键盘事件和细粒度惯性滚动。静态长页的快速浏览通常只由一次连续下滑和一次连续回滑完成；细小滚轮事件只是同一动作里的运动帧，不是多段停顿，即使 `human` 也会保持长距离运动快速。档位只改变中央节奏与异常保护深度，`fast` 也不会退化成粘贴或跳滚。行为模式由 Profile 决定，运行中也可切换；任务提交不接受临时覆盖。面板任务卡显示 Worker 已确认的实际档位与生效时间，而不是只复述 Profile 设置。所有版本化 Task Pack 还强制使用 `full-human-v1` Journey 契约，对声明的页面变化做校验，并为每次成功任务生成 10/10 交互审计。

### 多 Agent 工作台

- 所有可信本机 Agent 共享 Profile，不再定义没有实际意义的“Profile 创建者”；单 Profile 的排他租约仍会保护登录态不被并发破坏。
- 面板只保留两个区域：任务与 Profile，不再展示容易混淆的 Agent 名录、报告、文件或消息工作台。
- 每个任务使用 `Agent-具体任务-创建时间` 的稳定名称，显示当前动作、Worker 已确认的实际行为档位、可视化进度、运行时间、累计冷却时间和总时间。
- 暂停、恢复、取消和删除记录都会校验任务最新状态；删除只隐藏已经完成清理的终态记录，不会把已执行动作变成可重放任务。
- 面板只承担轻量任务管理；结果解释与专项交付继续由发起任务的 Agent 完成。

## 定义专属生产任务

网站和业务逻辑应保留在核心之外：

```bash
node scripts/taskmaster.mjs task-packs scaffold ./my-pack --name my-pack --recipe paginated-list --json
node scripts/taskmaster.mjs task-packs validate ./my-pack --json
node scripts/taskmaster.mjs task-packs install ./my-pack --json
```

Task Pack 提供可复用任务类型。它只定义目标、顺序、选择器、平台限速、提取、检查点、输出和完成证据，不再编写鼠标或滚动细节。统一的 Human Journey 引擎负责会改变页面状态的拟人操作；只读 Playwright locator 与 `evaluate` 仍可不加节奏地批量提取 DOM。读取文本、属性和当前 `value` 合法，只有赋值、程序化点击或滚动等写操作会被拒绝。内置单页、分页列表、列表详情、可恢复批处理和表单工作流 5 种生产骨架。没有专项能力却要启动大任务时，Agent 只需调用一次高级工具 `taskmaster_scale_prepare`，由运行时启动内置只读 `surface-probe`，抽样一个代表页面、完成有界扫底与回看、识别阻塞并推荐骨架；只有一个小样任务通过后才放量。专项 Skill 只负责使用时机、输入映射、平台规则和结果解释。

## Agent 宿主支持

| 宿主 | 本地 MCP 自动注册 |
| --- | --- |
| Codex | 自动注册；本机已验证真实工具发现与 Task Master 工具调用 |
| WorkBuddy Desktop | 自动注册；已验证真实宿主拉起 bridge，运行时升级后需要重载宿主 |
| Hermes | 自动注册；本机已验证发现 MCP 工具面，并真实调用 `taskmaster_status` 与 `taskmaster_profiles_list` |
| Claude Desktop、Claude Code | 自动注册；仍需对应宿主加载配置并完成一次真实工具调用，才能证明已激活 |
| CodeBuddy CLI、Gemini CLI | 已有自动注册适配器，真实宿主矩阵待补 |
| OpenClaw | 已有官方 CLI 注册适配器，真实宿主矩阵待补 |
| DeepSeek Harness、VS Code/Copilot、OpenCode | 宿主支持 MCP，安全自动适配器待完成 |
| Pi | 按宿主设计需要 MCP 扩展 |

每个 Agent 宿主独立启动一个 STDIO MCP bridge，所有 bridge 共同复用一个 Manager、Profile 目录、调度器和持久任务运行时。CLI 只保留为应急兼容路径；每个独立 CLI Agent 必须保持一个稳定且不同的 `--agent-id`，复用同一 ID 会有意共享该身份的任务记录和 Owner 收件箱。完整宿主矩阵和可信本机边界见 [`docs/MCP-HOSTS.md`](./docs/MCP-HOSTS.md)。

发布门槛使用 4 个独立、分别携带 Codex、WorkBuddy 与 Hermes 身份的真实 STDIO MCP 协议客户端接入同一个隔离 Manager，验证共享 Profile、按 Agent 隔离任务与产物、同 Profile 排队、不同 Profile 并行，以及 Agent 重连时任务不中断。真实宿主加载和工具调用另行在已安装宿主上验收。

## 验收与停止

运行完整本地验收：

```bash
npm run check
```

它覆盖静态边界、单元/集成/安全测试、真实 Chromium 验收以及并发、故障、重启工作负载。GitHub CI 会在 Windows、macOS、Linux 的 Node.js 20 和 22 上验证。Release 需要人工授权，并且带校验和且不可覆盖。

安全停止 Manager：

```bash
node scripts/taskmaster.mjs manager stop --json
```

新 Agent 从 [`skills/eric-task-master/SKILL.md`](./skills/eric-task-master/SKILL.md) 开始。技术细节位于 [`ARCHITECTURE.md`](./ARCHITECTURE.md)、[`docs/MCP.md`](./docs/MCP.md) 和 [`docs/RELEASE-GATE.md`](./docs/RELEASE-GATE.md)。

## 开源许可

[MIT](./LICENSE)。你可以自由使用、修改和分发 Task Master，也可以在其上构建开源或商业化的 Skill 与 Task Pack。
