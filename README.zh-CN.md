# Eric Task Master 3.00

**领任务，写最小脚本，一条命令立即运行。**

Eric Task Master 是给本机 AI Agent 使用的全时 Chrome 任务系统。Codex、Claude Code、WorkBuddy、Hermes、Pi，以及任何能调用本机终端的 Agent，都可以通过同一条 CLI 启动长任务、持续输出结果，并在 Agent 退出后继续运行。

[English](README.md)

## 它解决什么

Agent 内置浏览器往往短暂且不适合长任务；直接控制浏览器又容易在 Agent 回合结束后丢失进度、状态和清理能力。Task Master 只接管长期运行层，浏览器怎么操作完全交给 Agent。

- **最快启动：**写一份最小 `.mjs`，执行一条命令。
- **完全自由：**直接使用 Playwright、`page.evaluate()`、CDP、HTTP、文件和自定义重试。
- **长期运行：**Agent 断开后，Manager 和 Worker 继续工作。
- **真实登录态：**命名 Profile 使用本机稳定版 Chrome，登录一次长期保留。
- **多 Agent 并行：**不同 Profile 可以同时运行；同一 Profile 保持单写。
- **边做边交付：**处理多少就保留多少，任务停止不否定已有结果。
- **验证不丢任务：**保留浏览器，立即发送系统通知、之后每 30 秒一次；第 5/10/15/20 分钟截图。实际恢复即停止提醒；20 分钟仍未恢复则自动暂停、停止提醒，保留现场等待手动恢复。
- **自动收尾：**回收僵尸租约；停止和删除会终止所属进程并释放 Profile。
- **对接极简：**只有 CLI 和本机面板，没有 MCP、浏览器插件、配对码和 Task Pack 资产库。

它可以承载无人值守调研、长期采集、账号运营、表单任务、网页监控、内容流程、质量检查，以及 Agent 能用 JavaScript 描述的任何网页工作。

## 安装

从[最新 GitHub Release](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest)下载两个文件：

1. 对应系统和 CPU 的 Manager **安装包或便携 ZIP**；
2. `eric-task-master-skill-v3.1.1.zip`。

Manager 安装包自带 Node.js、Playwright、CLI、本机面板和后台服务，只使用电脑上已安装的稳定版 Google Chrome，不再下载独立 Chromium。

安装失败时，下载 `eric-task-master-v3.1.1-<target>-portable.zip`，核对 `SHA256SUMS` 后解压到长期保留的文件夹。Windows 运行 `eric-task-master/bin/taskmaster.cmd panel`，macOS/Linux 运行 `eric-task-master/bin/taskmaster panel`。无需安装器、管理员权限或单独安装 Node.js。[选择对应包与部署说明](docs/INSTALLERS.md#portable-zip-fallback)。

安装后运行：

```bash
taskmaster panel
```

创建 Profile，在打开的原生 Chrome 窗口里登录，关闭该窗口并设为默认，任务会复用同一 Profile。然后把 Skill 给 Agent，直接告诉它任务。网站仍可能要求再次验证。

面板的「清理空间」可清理闲置 Profile 的浏览器缓存与已结束任务的临时脚本；历史截图、下载和结果需单独勾选。登录态、扩展数据和正在使用的任务不会被清理。

## Agent 固定路径

```bash
taskmaster run ./job.mjs --input '@./input.json' --detach --json
taskmaster follow TASK_ID --json
```

不指定 `--profile` 时自动使用面板默认 Profile。Manager 没启动时，`run` 会自动后台启动。

最小任务：

```js
export async function run({ page, input, outputDir, progress, signal }) {
  await page.goto(input.url, { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  await progress({ current: 1, total: 1, message: '已读取标题' });
  return { title, outputDir, aborted: signal.aborted };
}
```

提交时只会冻结入口 `.mjs`。请保持单文件自包含：可使用 Node 内置模块、`playwright` 裸导入、任务 `input`、绝对路径和 `outputDir`；不会复制源码旁边的相对导入或资源文件。

## 核心命令

```bash
taskmaster status --json
taskmaster profiles --json
taskmaster run ./job.mjs --input '@./input.json' --json
taskmaster follow TASK_ID --json
taskmaster stop TASK_ID --json
taskmaster resume TASK_ID --json
taskmaster delete TASK_ID --json
taskmaster panel
```

## 信任模型

任务脚本以当前操作系统用户权限运行，属于可信本地代码。Task Master 不假装提供脚本沙箱，只运行你信任的 Agent、Skill 和脚本。

Manager 自身只监听 `127.0.0.1`，不会在自己的诊断中记录凭据，不会自动重放整份失败脚本，也不会让两个浏览器同时写入同一个 Profile。

## 项目第一原则

> **领任务 → 写最小自由脚本 → 一条 CLI 运行 → 边跑边输出结果。**

如果一个功能不能让任务更快启动、更稳定运行或更容易收尾，却让 Agent 在第一次浏览器操作前多走一步，它就不应该进入 Manager。

## License

MIT

关键词：AI Agent 浏览器自动化、Playwright、Chrome 自动化、长期任务、无人值守、多 Agent、浏览器 Profile、CLI 自动化、RPA、网页调研、数据采集。
