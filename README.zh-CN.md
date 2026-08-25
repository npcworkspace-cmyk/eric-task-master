# Eric Task Master

[English](./README.md) | [简体中文](./README.zh-CN.md)

**为 AI Agent 打造的持久化浏览器自动化任务系统。**

AI Agent 已经能够理解需求、制定计划和编写代码，但浏览器执行往往仍是最薄弱的一环。Agent 内置浏览器适合短时交互，却很难稳定保留登录态、任务上下文和恢复现场；简单的 CDP 控制器虽然能快速操作真实浏览器，却会迫使每个 Agent 为每次任务重新编写控制器、进度跟踪、异常恢复和清理逻辑。

Eric Task Master 正是为解决这个缺口而开发。它以 Playwright 为执行核心，把网页操作变成持久、隔离、可观察、可恢复的任务。Agent 可以启动一个持续数小时的工作，暂时离开后重新接管，通过检查点继续，读取可验证的结果，并确认所有任务窗口已经关闭，而不占用或打扰用户的日常浏览器，也不需要反复消耗 Token 去重新理解同一套控制机制。

`AI Agent` · `浏览器自动化` · `Playwright` · `MCP Server` · `Web Automation` · `Computer Use` · `工作流自动化` · `Browser Agent` · `Headless Browser` · `多 Agent 自动化`

## Agent 可以用它构建什么？

Task Master 是通用执行基座，不是某一个网站的专用机器人。搭配 Agent、专项 Skill 或 Task Pack，可以用于：

- 无人值守的网页研究、信息监测和带来源的数据采集；
- 跨越数百个页面的长时间批量任务，不必持续占用一个 Agent 回合；
- 使用独立持久化 Profile 完成需要登录态的后台、门户、CMS、CRM 和账号工作；
- 使用隐身临时 Profile 完成不需要登录、任务结束即销毁的干净任务；
- 多个 Agent 同时操作不同 Profile，互不抢标签页、登录态和任务记录；
- 由 Agent、定时器或业务系统触发的日常重复工作流；
- 浏览器 QA、内容核验、表单处理、文件上传下载和证据留存；
- 进一步封装成销售线索、电商运营、媒体研究、供应商研究、客服、合规检查或内部 RPA 等生产级 Task Pack。

这些是可组合的应用方向，不代表内置了所有网站权限，也不代表任何网站都能无条件自动化。Task Master 负责稳定的浏览器执行；专项 Skill 或 Task Pack 负责业务逻辑、平台规则、解析方式、检查点、结果格式和完成证据。

## 为什么不直接使用 Agent 内置浏览器或临时 CDP 脚本？

| 方式 | 优势 | 通常欠缺的部分 |
| --- | --- | --- |
| Agent 内置浏览器 | 临时浏览和短时交互方便 | 持久任务、登录 Profile、长任务恢复、多 Agent 隔离、清理证明 |
| 一次性 CDP 控制器 | 原始控制快、灵活 | 稳定生命周期、队列、进度、检查点、证据、恢复和可复用任务契约 |
| Eric Task Master | 面向生产形态的浏览器任务 | 网站与行业知识，由 Skill 和 Task Pack 按需叠加 |

Task Master 不替代 Agent 的思考能力，而是给 Agent 一双长期稳定、不会轻易失联的浏览器“手”。

## 三层模型

1. **Task Master 运行时**：纯 Playwright 执行、持久化与临时 Profile、任务队列、进度、恢复、证据和清理。
2. **Web 控制中台**：同源 Dashboard 统一管理 Profile 和任务；用户直接在隔离的 Playwright 持久 Profile 中登录。
3. **MCP + Skills + Task Packs**：Agent 只接触精简的高级任务接口，行业和网站能力独立叠加，不污染核心。

这样可以用一个稳定的万能基座，持续定义不同的专属批量行动助手。

## 给新 Agent：唯一固定启动协议

当用户把 GitHub 链接交给你时，必须按以下顺序执行。不要另外发明 daemon、端口、浏览器启动器、控制器或任务轮询脚本。

> 完整 GitHub 仓库才是运行时。单独的 Skill 压缩包只是 Agent 指令适配层，脱离完整 `eric-task-master` 项目不能运行。

1. 如果仓库是私有的，先确认当前环境拥有 GitHub 访问权限，然后拉取完整仓库。
2. 确认 Node.js 版本不低于 20。
3. 阅读 `skills/eric-task-master/SKILL.md`。宿主支持 Skill 时安装这个目录；不支持时就在仓库中原地遵循它。
4. 在项目根目录只运行：

   ```bash
   node scripts/taskmaster.mjs connect --json
   ```

5. `connect` 会安装锁定依赖和匹配的 Playwright Chromium；在旧 Manager 空闲时完成可信的优雅升级；启动本地 Manager；执行真实浏览器验收；并注册已支持的 MCP 宿主。如果旧 Manager 还有任务，升级会停止且不会打断原任务。
6. 严格执行返回的 `nextAction`。修复明确前置条件后，最多原样重试同一条命令一次；不要发散成另一套临时控制器。
7. 需要管理 Profile 或任务时，打开返回的 Dashboard URL。它只包含短时一次性授权码，不包含 Manager 凭据。
8. 如果宿主返回 `registered_pending_restart`，让用户只重启或重新加载该 Agent 宿主一次。
9. 调用 `taskmaster_status` 和 `taskmaster_profiles_list`。两项成功后，再询问用户要执行什么浏览器任务。

可以直接复制给新 Agent：

> 安装并启动 `https://github.com/npcworkspace-cmyk/eric-task-master`。拉取完整仓库，阅读或安装 `skills/eric-task-master`，只运行 `node scripts/taskmaster.mjs connect --json`，不要发明其他控制器或端口。返回已授权的 Dashboard URL；状态和 Profile 检查成功后，询问我要执行什么任务。

## 日常使用

首次启动完成以后，用户只需要自然描述任务，例如：

> 使用 Eric Task Master，创建隐身临时 Profile，以 adaptive 模式研究这些网站，定时反馈进度，保存结果证据，任务结束后关闭所有窗口。

Agent 随后只走一条持久任务路径：发现任务类型、使用幂等键提交一次、保存任务 ID、持续等待或重新接管同一个 ID、在需要关注时读取诊断信息，并且只在证据和清理全部通过后宣布完成。

### Profile

- **persistent**：适合登录态和重复账号工作；从 Dashboard 打开后，直接在该 Playwright 窗口中登录；
- **ephemeral / 隐身临时**：每个无登录任务都使用全新非持久浏览器，清理后销毁。

### 行为模式

- **fast**：确定性操作和批量数据任务优先速度；
- **human**：使用有界鼠标、输入、滚动和阅读节奏；
- **adaptive**：默认快速，遇到动态页面、遮挡、超时、导航不确定、动作失败或限流时暂时转为谨慎或拟人节奏。

拟人节奏是提高交互可靠性的策略，不代表绕过网站控制，也不承诺保护账号免受平台规则影响。

## 定义专属生产任务

网站和业务逻辑应保留在核心之外：

```bash
node scripts/taskmaster.mjs task-packs scaffold ./my-pack --name my-pack --json
node scripts/taskmaster.mjs task-packs validate ./my-pack --json
node scripts/taskmaster.mjs task-packs install ./my-pack --json
```

Task Pack 提供可复用任务类型；专项 Skill 教 Agent 何时使用、如何理解结果以及需要遵守哪些平台规则。二者都不应重新实现 Manager、浏览器生命周期、任务跟踪、诊断或清理。

## Agent 宿主支持

| 宿主 | 本地 MCP 自动注册 |
| --- | --- |
| Codex、Claude Desktop、Claude Code、Hermes | 已支持 |
| WorkBuddy、DeepSeek Harness、Pi、OpenClaw | 仍需适配器，当前版本不会自动修改其配置 |

没有宿主专用 MCP 适配器时，仍可通过固定 CLI 使用浏览器运行时。

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
