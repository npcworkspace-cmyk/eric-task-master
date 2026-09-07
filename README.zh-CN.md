# Eric Task Master · 任务大师

**让 Agent 离开对话框以后，任务仍然继续。**

Eric Task Master 是运行在本机的全时浏览器任务底座。Agent 负责理解目标和生成最小脚本；Task Master 负责让真实 Chrome、登录态、任务进程、进度和结果跨越单次对话持续运行。它不替代 Agent，也不把工作锁进固定流程，而是把临时浏览器操作变成可并行、可恢复、可复用的自动化能力。

Codex、Claude Code、WorkBuddy、Hermes、Pi，以及任何能调用本机终端并读取 JSON 的 Agent，都可以通过同一套 CLI 使用它。

[English](README.md) | 简体中文 | [下载最新版](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest) | [Task Master Skills 社区库](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/blob/main/README.zh-CN.md)

## 它能把什么交给 Agent

- **长期调研与数据采集：**跨页面搜索、读取、整理和持续落盘，不因 Agent 一轮对话结束而中断。
- **无人值守批量任务：**让脚本按目标、顺序、限速和检查点在后台持续工作，适合小时级或夜间任务。
- **多账号与多工作空间：**每个 Chrome Profile 独立保存登录态；不同 Profile 可以被不同 Agent 同时使用，互不抢窗口。
- **网页运营与重复操作：**后台录入、表单处理、内容流程、商品与账号工作，都可以由专用脚本或 Skill 定义。
- **监测、巡检与质量检查：**持续观察页面变化、检查流程结果、记录异常，并把中间结果逐步交付出来。
- **可复用的专业能力：**把验证有效的任务脚本、业务规则和结果检查方法沉淀为 Skill，交给更多 Agent 和电脑复用。

它适合承载“任务明确、需要真实 Chrome、执行时间较长、结果必须保留”的网页工作。一次性需求可以立即运行；成熟流程可以继续升级为专业 Skill。

## 为什么不只用 Agent 内置浏览器

Agent 内置浏览器适合即时交互，却很难承载长时间、可恢复、带登录态的任务。直接启动 Playwright 虽然自由，但每个 Agent 都要重新处理进程、Profile、进度、结果和清理。

Task Master 补上的是中间这一层：

- **Agent 退出，任务不退出：**本机 Manager 和 Worker 继续运行。
- **登录一次，后续复用：**命名 Profile 使用本机稳定版 Chrome，并长期保留浏览器状态。
- **多个 Agent，各做各的：**不同 Profile 可并行运行；同一 Profile 始终只有一个写入者。
- **边做边交付：**进度和文件在运行中就可读取；任务提前停止也不否定已经落盘的结果。
- **遇到人工验证不丢现场：**保留浏览器、通知用户并支持暂停后恢复。
- **结束以后自动收尾：**停止或删除任务时终止所属进程、释放 Profile，并在确认旧进程已停止后回收失效租约。

## 一个基座，三种使用深度

### 1. Manager：稳定执行层

Manager 负责浏览器进程、Profile 租约、任务状态、进度、输出文件、停止、恢复和清理。人可以在本机面板查看当前工作，Agent 通过 CLI 使用同一套状态。

### 2. `.mjs`：最快的自由任务

Agent 收到新需求后，只写一份最小 JavaScript 文件就能运行。脚本可以直接使用 Playwright、`page.evaluate()`、CDP、HTTP、本地文件、自定义并发、限速、重试和检查点；Manager 不强迫它套用额外动作框架。

### 3. Skill：可复用的专业能力

当一套流程被反复验证后，可以把操作方法、执行脚本、业务约束和结果检查沉淀成 Skill。Task Master 保持通用，垂直能力在 Skill 层独立迭代，避免一个核心项目塞入所有网站和业务逻辑。

这三层既可以单独使用，也可以组合：临时需求直接跑小脚本，稳定需求调用专业 Skill，所有任务共用同一个长期运行基座。

## 平台价值

Task Master 的目标不只是“控制一个浏览器”，而是成为多个 Agent 共用的本机任务执行平台：

- **统一入口：**不同 Agent 都使用同一条 CLI 路径，不依赖专属插件或宿主协议。
- **任务与 Agent 解耦：**任务由 Manager 持有，不依赖发起它的对话窗口继续存在。
- **能力与基座解耦：**业务变化只更新脚本或 Skill，不需要不断修改 Manager。
- **数据由任务掌握：**输出是普通文件，可继续分析、审计、转换和交付，不被锁进面板。
- **减少重复成本：**复用登录态、任务状态和专业 Skill，减少 Agent 反复观察页面、重建上下文和重写控制器带来的时间与 Token 消耗。
- **从一次性到规模化：**先用最小脚本验证，再把高价值流程沉淀为 Skill，逐步形成个人或团队的自动化能力库。

因此，同一套基座可以用于网页调研、数据采集、内容和账号流程、电商后台、线索开发、页面监控、浏览器 QA，以及 Agent 能用 JavaScript 描述的其他任务。

## 工作方式

```text
专业 Skill ─┐
临时 .mjs ──┼─> Agent ─> taskmaster CLI ─> 本机 Manager ─> Worker ─> Chrome Profile
自然语言任务 ┘                              │
                                             └─> 进度、事件、结果文件

人 ───────────────────────────────> 本机面板：任务控制与 Profile 管理
```

Agent 与 Manager 的通信是本机 CLI + 机器可读 JSON：

1. `run --detach` 提交脚本和输入，立即返回任务 ID；
2. `follow` 持续读取进度、状态和事件游标；
3. `files` 列出任务产物，`files --read` 读取指定结果文件；
4. `stop`、`resume`、`delete` 控制任务生命周期。

Manager 只监听 `127.0.0.1`。不需要 MCP 注册、浏览器插件、配对码或为每个 Agent 单独部署控制器。

## 三步部署

### 第一步：安装 Manager

电脑需要先安装稳定版 Google Chrome。然后从[最新 GitHub Release](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest)下载两个文件：

1. 对应系统和 CPU 的 Manager **安装包或便携 ZIP**；
2. `eric-task-master-skill-v<VERSION>.zip`。

| 系统 | 安装包 | 便携包 |
| --- | --- | --- |
| Windows 10/11 x64 | `eric-task-master-v<VERSION>-windows-x64-setup.exe` | `eric-task-master-v<VERSION>-windows-x64-portable.zip` |
| macOS Apple silicon | `eric-task-master-v<VERSION>-macos-arm64.pkg` | `eric-task-master-v<VERSION>-macos-arm64-portable.zip` |
| macOS Intel | `eric-task-master-v<VERSION>-macos-x64.pkg` | `eric-task-master-v<VERSION>-macos-x64-portable.zip` |
| Debian/Ubuntu x64 | `eric-task-master-v<VERSION>-linux-x64.deb` | `eric-task-master-v<VERSION>-linux-x64-portable.zip` |
| Debian/Ubuntu arm64 | `eric-task-master-v<VERSION>-linux-arm64.deb` | `eric-task-master-v<VERSION>-linux-arm64-portable.zip` |

安装包自带 Node.js、Playwright、CLI、本机面板和按需启动的后台 Manager；用户不需要再配置 Node.js 或下载 Chromium。

安装器不可用时，下载 `eric-task-master-v<VERSION>-<target>-portable.zip` 和同一 Release 的 `SHA256SUMS`，校验后解压到长期保留的目录：

```powershell
# Windows
& 'C:\Tools\eric-task-master\bin\taskmaster.cmd' panel
```

```bash
# macOS / Linux
'/absolute/path/eric-task-master/bin/taskmaster' panel
```

便携包不要求管理员权限，也不依赖系统 Node.js。当前 Windows 和 macOS 安装包尚未签名，系统可能要求用户确认；便携 ZIP 不会绕过 SmartScreen 或 Gatekeeper。完整的平台选择、升级和兼容范围见[部署文档](docs/INSTALLERS.md)。

### 第二步：准备默认 Profile

运行：

```bash
taskmaster panel
```

在面板创建 Profile，打开它的原生 Chrome 窗口并完成登录；关闭窗口后，把该 Profile 设为默认。自动化任务会复用同一份登录状态。网站仍可能在之后要求重新验证。

### 第三步：把 Skill 给 Agent

通过 Agent 的 Skill 管理界面导入 `eric-task-master-skill-v<VERSION>.zip`；如果使用目录式安装，先解压，再确认 Skill 根目录直接包含 `SKILL.md`。Agent 不支持 Skill 时，也可以直接把本仓库链接交给它，让它阅读 `skills/eric-task-master/SKILL.md`。

之后只需要告诉 Agent 具体任务。它会沿固定路径写最小 `.mjs`、运行一次、返回面板地址并持续跟进结果。

## Agent 固定路径

```bash
taskmaster run ./job.mjs --input '@./input.json' --detach --json
taskmaster panel --json
taskmaster follow TASK_ID --wait-ms 60000 --json
taskmaster files TASK_ID --json
```

第一次 `follow` 不需要游标；后续调用使用返回的 `after` 值继续读取：`taskmaster follow TASK_ID --after AFTER --wait-ms 60000 --json`。不指定 `--profile` 时使用面板中的默认 Profile。Manager 未启动时，`run` 会自动在后台启动。所有命令都支持 `--json`，便于不同 Agent 稳定解析。

最小任务：

```js
export async function run({ page, input, outputDir, progress, signal }) {
  await page.goto(input.url, { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  await progress({ current: 1, total: 1, message: '已读取标题' });
  return { title, outputDir, aborted: signal.aborted };
}
```

提交时只冻结入口 `.mjs`。请保持单文件自包含：可以使用 Node.js 内置模块、裸导入 `playwright`、任务 `input`、绝对路径和 `outputDir`；入口旁边的相对导入或资源不会被自动复制。

## 核心命令

```bash
taskmaster status --json
taskmaster profiles list --json
taskmaster profiles create NAME --json
taskmaster profiles default NAME_OR_ID --json
taskmaster run ./job.mjs --input '@./input.json' --detach --json
taskmaster follow TASK_ID --wait-ms 60000 --json
taskmaster files TASK_ID --json
taskmaster files TASK_ID --read RELATIVE_PATH --json
taskmaster stop TASK_ID --json
taskmaster resume TASK_ID --json
taskmaster delete TASK_ID --json
taskmaster panel
```

## 长任务、验证和结果

- 任务脚本应把有价值的数据持续写入 `outputDir`，不要等到最后才一次保存。
- `progress()` 用于报告当前动作和已处理数量；`follow` 可在 Agent 重连后从事件游标继续读取。
- 脚本检测到验证页面时可以调用 `wait({ reason: 'verification' })`。Manager 保留 Chrome 和 Worker，通知用户、保存诊断截图，并在限定时间后保留现场自动暂停。
- 任务可以由 Agent 或人在面板恢复；截图探测期间，Agent 按 `follow` 返回的当前 `probeId` 恢复。Task Master 不自动识别或破解验证码。
- 面板只显示排队、运行、等待和停止中的当前任务。任务结束后卡片自动消失，但记录和结果仍可通过 CLI 读取或显式清理。
- 面板的「清理空间」可删除闲置 Profile 缓存和已结束任务的临时脚本；历史结果需要单独选择，登录态、扩展数据和正在使用的任务不会被清理。

## 为什么容易维护和扩展

- **核心很薄：**Manager 只维护任务、进程、Profile、进度和结果，不内置站点规则。
- **升级边界清楚：**应用程序与用户 Profile、登录态、任务记录分开存放，升级 Manager 不需要重建业务能力。
- **运行环境一致：**安装包自带经过当前版本验证的 Node.js 和 Playwright，减少不同 Agent 电脑上的依赖漂移。
- **脚本无需注册：**新任务不进入资产库，不用维护 Task Type；一次性脚本提交后即可运行。
- **Skill 独立演进：**网站适配、行业知识和结果验收在各自 Skill 中维护，可以单独发布、替换和复用。
- **跨平台一致：**Windows、macOS 和 Linux 使用同一 CLI 合约与同一种任务文件。

## Task Master Skills 社区

想先用现成工作流，可以到 [Task Master Skills 社区库](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/blob/main/README.zh-CN.md)寻找红人开发、社群调研等能力。配套 Skill 提供具体工作的操作说明、执行脚本和结果检查方法；Skill 按需安装，也可以继续直接运行自己的脚本。

有一套已经帮你节省时间的工作流？欢迎把有用部分整理成 Skill。可以先[提交想法](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/issues/new?template=skill-proposal.md)，改进已有 Skill，或者按照[贡献指南](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/blob/main/CONTRIBUTING.md)提交 PR。审核通过后，它就能成为其他人可以下载、安装和使用的版本。

我们希望一个人和自己的 Agent 也能组织大批量、有结果的工作。每一个共享工作流、经过验证的修复和更清楚的说明，都在帮助下一个人多自动化一部分工作，让个人与小团队的规模化自动化逐步成为可能。

**两个项目的分工：**

- [Eric Task Master 任务大师](https://github.com/npcworkspace-cmyk/eric-task-master)：安装在本机的长期任务执行基座。
- [Task Master Skills](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill)：寻找、开发和分享可复用的专业工作流。

## 信任模型

任务脚本以当前操作系统用户权限运行，属于可信本地代码。Task Master 不假装为脚本提供安全沙箱；只运行你信任的 Agent、Skill 和脚本。

Manager 控制面只监听本机 `127.0.0.1`，对自己的诊断信息进行凭据脱敏，不会自动重放整份失败脚本，也不会让两个浏览器同时写入同一个 Profile。任务脚本本身拥有网络和文件能力，其实际行为由脚本作者负责。

## 项目第一原则

> **领任务 → 写最小自由脚本 → 一条 CLI 运行 → 边跑边输出结果。**

如果一个功能不能让任务更快启动、更稳定运行或更容易收尾，却让 Agent 在第一次浏览器操作前多走一步，它就不应该进入 Manager。

## License

MIT

关键词：AI Agent 浏览器自动化、AI 自动化平台、Playwright、Chrome 自动化、长期任务、无人值守自动化、多 Agent、浏览器 Profile、CLI 自动化、RPA、网页调研、数据采集、工作流 Skill、跨平台 Agent 工具。
