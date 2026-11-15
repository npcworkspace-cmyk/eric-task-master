# Eric Task Master 4.0 · 任务大师

**让 AI Agent 的浏览器任务，在本机持续执行。**

Agent 负责计划和判断，任务大师负责保留浏览器、任务状态、进度与结果，让工作不止于一轮对话。

Eric Task Master 运行在你自己的电脑上，为能调用终端的 Agent 提供统一 CLI，既能执行一次性批量任务，也能维持常驻操作：提交脚本、保留选定的 Chrome Profile、等待条件或定时事件、交给人工接管，再根据已记录的状态继续。业务逻辑和决策来自 Agent，任务大师负责执行与生命周期管理；它不是一个通用全自主 Agent。

[English](README.md) | 简体中文 | [下载最新版](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest) | [4.0.1 发布说明](docs/releases/4.0.1.md) | [Task Master Skills 社区库](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/blob/main/README.zh-CN.md) | **[NPC 官网 ↗](https://www.npctech.site/)**

**NPC 核子力文化科技**：甲方操盘手出身的全球公关与品牌团队，也是媒体资源平台「媒介桥」和 AI 工具「任务大师」的打造者。

[了解 NPC ↗](https://www.npctech.site/) · [媒介桥 · npcpressbridge.com ↗](https://npcpressbridge.com/)

## 发挥你的想象力

任务明确、需要真实浏览器、执行时间较长，又不能丢掉身份和结果的工作，都适合从一个小脚本开始：

- 长时间调研与公开数据采集，边做边保存有效结果。
- 重复网页任务，由脚本负责限速、检查点和结果核验。
- 网页监测，在本机等待条件变化，需要判断时再产生事件。
- 经过授权的内容、广告或网站流程，限定操作范围并读回确认。
- 浏览器质量检查、文件下载归档，以及可复用的专业 Skill。

这些是可构建的工作流方向，不代表所有网站都已兼容。具体站点怎么操作、怎样确认结果，仍由脚本或 Skill 定义，并需要在相应平台和授权范围内验证。

Codex、Claude Code、WorkBuddy、Hermes、Pi，以及其他能运行本机 CLI、读取 JSON 的 Agent，都可以使用同一接口。核心运行时不需要逐个宿主安装插件、注册 MCP 或安装浏览器扩展。

## 两种执行模式

| 模式 | 适合什么 | 何时结束 |
| --- | --- | --- |
| `batch` | 有限动作组、一次性任务 | 本次限定工作完成后结束 |
| `operations` | 持续观察、分批指令、条件等待和定时决策 | 保留任务与 Chrome 上下文，直到停止或达到限制 |

任务 prompt 明确指定模式时，只覆盖本次任务，不修改 Profile 的默认值。否则按 Profile 策略选择；`auto` 参考 Skill 声明或等待、后续跟进意图，最后回退到 batch。`auto` 是选择策略，不是第三种执行引擎。

**人工接管是暂停锁，不是执行模式。** 接管时保留浏览器，阻止自动修改；自动化不能自行解除。恢复需要明确操作，旧目标引用失效，未确认的外部结果必须先核对。切换模式不会切换身份，也不会扩大权限。

## 4.0 带来的变化

### 常驻操作

同一个任务、Worker 和 Chrome 上下文可以承接多批有限指令：观察指定区域、使用当前页面的有效目标、执行小批动作、确认结果，再等待下一步。本机条件观察器负责安静等待，不必每次轮询都请求模型判断。

普通 `.mjs` 任务继续保留。脚本仍可直接使用内置 Playwright、CDP、HTTP、Node.js 工具、自定义重试和检查点；Manager 不要求注册网站专属任务类型或脚本资产。

### 定时事件与明确决策

定时计划记录时间、时区、允许执行窗口、有效期和次数限制。错过的工作按有限补偿策略处理，不会无上限补跑。事件区分 **pending、delivered、received、handled**：送达不等于 Agent 已判断，更不等于业务动作成功。

在线 Agent 可以通过 CLI 长轮询接收事件；明确配置的宿主适配器也可以把事件交给另一个进程。可选的 [在线 Codex CLI 适配器](docs/CODEX-HOST-ADAPTER.md) 使用独立安装、已有登录的 Codex CLI，只在事件到来时调用，并持久记录模型调用额度。目前它只接受白名单范围的**只读观察或安全停止**，不负责发布、发消息或修改业务记录。

### 授权、读回和恢复

常驻操作把权限绑定到选定的浏览器与账号、资源、域名、允许动作和有效期。Manager 在执行前记录动作，在外部效果发生前持久确认启动，再通过读回判断预期结果是已确认还是未知。

结果不明的写入不会自动重试。必须回到同一授权资源，核对原始预期结果后再决定下一步。可选的单次发送传输策略，为明确选定的任务大师 Profile、已知的小型同源 JSON POST 增加有限保护；它和动作记录都不等于外部系统的通用“恰好一次”保证。

具体配置、命令、传输限制与恢复规则见 [Fast operations](docs/FAST-OPERATIONS.md)。

## 小核心，可复用的工作流

```text
Agent + 可选 Skill
        │ 计划、脚本、决策
        ▼
taskmaster CLI → 本机 Manager → Worker → 选定的 Chrome Profile
                      │
                      ├─ 任务状态、进度与结果文件
                      └─ 常驻操作、计划与持久事件

用户 → 本机 Dashboard → 任务控制、Profiles 与人工接管
```

Manager 管进程、Profile 租约、任务状态、进度、结果和清理；脚本与 Skill 管站点行为和业务逻辑。不同 Profile 可以并行，同一个 Profile 同时只有一个写入者。Dashboard 只保留 Tasks 和 Profiles 两个工作视图。

Agent 一轮对话结束后，已提交任务可以继续运行，**前提是本机电脑和运行时仍在运行**。这不代表休眠、关机或 Agent 宿主关闭后仍能执行，也不承诺所有浏览器现场都能在重启后自动恢复。

## 安装 4.0.1

### 1. 先定位已有安装

新 Agent 部署时，**先检查 Manager，缺少时才安装**。所需版本已部署时，**只给新 Agent 安装或更新 Skill**。发现旧版则安排明确授权的空闲升级，不另建第二套 Manager 或替换已有 Profile 池。

Windows 使用 Skill 的[只读启动器定位脚本](skills/eric-task-master/scripts/find-launcher.ps1)；macOS/Linux 使用已安装或已知便携目录中的启动器。用 `--help` 确认绝对路径，本次会话继续使用该路径。定位不明确或状态目录报错，不等于可以重新安装、合并数据或重建 Profile。

同一系统用户下的 Agent 默认共用一个选定的 Manager 和 Profile 池。独立项目需要在每条命令中明确传入 `--state-dir ABSOLUTE_DIRECTORY`。常规启动会复用兼容的运行中 Manager，不会静默替换版本。

**Manager 与 Agent Skill 是两份独立安装。** 更新 Skill 不会升级运行时。旧安装要使用 4.0 能力，应由 Owner 明确安排空闲升级；原生安装和卸载会拒绝占用中的运行时。保留已有 Profile、任务记录与输出，详见[安装说明](docs/INSTALLERS.md)和[状态恢复](docs/STATE-BACKUP-RECOVERY.md)。

### 2. 下载对应系统的运行时与 Skill

全新安装先准备稳定版 Google Chrome，再从[最新 Release](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest)或[固定版本 4.0.1](https://github.com/npcworkspace-cmyk/eric-task-master/releases/tag/v4.0.1)选择文件。

| 平台 | 原生安装包 | 便携 ZIP |
| --- | --- | --- |
| Windows 10/11 x64 | `eric-task-master-v4.0.1-windows-x64-setup.exe` | `eric-task-master-v4.0.1-windows-x64-portable.zip` |
| macOS Apple silicon | `eric-task-master-v4.0.1-macos-arm64.pkg` | `eric-task-master-v4.0.1-macos-arm64-portable.zip` |
| macOS Intel | `eric-task-master-v4.0.1-macos-x64.pkg` | `eric-task-master-v4.0.1-macos-x64-portable.zip` |
| Debian/Ubuntu x64 | `eric-task-master-v4.0.1-linux-x64.deb` | `eric-task-master-v4.0.1-linux-x64-portable.zip` |
| Debian/Ubuntu arm64 | `eric-task-master-v4.0.1-linux-arm64.deb` | `eric-task-master-v4.0.1-linux-arm64-portable.zip` |

同时下载该 Release 下的 **`eric-task-master-skill-v4.0.1.zip`**、`SHA256SUMS` 和 `UNSIGNED-BUILD.txt`，安装前核对校验和。Windows 和 macOS 包尚未签名；使用便携 ZIP 也不能绕过 SmartScreen 或 Gatekeeper。

运行时包含 Node.js、Playwright、CLI、Dashboard 和后台 Manager，使用本机稳定版 Chrome，不另行捆绑 Chromium。便携包不要求系统安装 Node.js 或管理员安装；解压到固定目录后调用启动器：

```powershell
# Windows 便携版示例
& 'C:\Tools\eric-task-master\bin\taskmaster.cmd' panel
```

```bash
# macOS / Linux 便携版示例
'/absolute/path/eric-task-master/bin/taskmaster' panel
```

### 3. 选定浏览器，把 Skill 交给 Agent

运行 `taskmaster panel`。普通脚本工作应保留已有 Profile，或创建命名 Profile、打开原生 Chrome 窗口、按需登录，关闭手动窗口后选定默认 Profile。不要因为启动器定位出错就替换原有 Profile。

**已登录账号后台默认使用用户明确选定的本机真实浏览器，经受支持的 browser-use 适配器操作。** 当前未捆绑此类 local-browser 适配器。缺少支持时，需要明确选择：连接选定的本机浏览器，或授权本次任务使用任务大师自有 Profile。不能静默切换身份、连接任意浏览器或替换成另一个 Profile。

通过 Agent 的 Skill 管理器导入运行时自带的 `app/skills/eric-task-master/` 或 `eric-task-master-skill-v4.0.1.zip`。采用目录安装时，确认 `SKILL.md` 位于 Skill 根目录；没有 Skill 管理器的 Agent 可以直接读取[驱动 Skill](skills/eric-task-master/SKILL.md)。宣布部署完成前，分别读回 Skill 元数据、绝对路径启动器的 `--help` 和运行中 `manager status --json`，三处均应为 4.0.1。

## 第一个批量任务

保存可信的最小 `job.mjs`：

```js
export async function run({ page, input, outputDir, progress, signal }) {
  await page.goto(input.url, { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  await progress({ current: 1, total: 1, message: 'Collected title' });
  return { title, outputDir, aborted: signal.aborted };
}
```

然后使用已确认的启动器：

```bash
taskmaster run ./job.mjs --input '{"url":"https://example.com"}' --detach --json
taskmaster panel --json
taskmaster follow TASK_ID --wait-ms 60000 --json
taskmaster files TASK_ID --json
```

`run` 按需启动 Manager 并返回任务 ID。后续 `follow` 带上上次返回的 `after` 游标继续读取。`panel --json` 只返回 Dashboard 地址，不会反复打开窗口。普通脚本省略 `--profile` 时使用选定的默认 Profile。

只有提交的 `.mjs` 入口会被冻结，旁边的文件不会自动复制；保持脚本自包含，或使用明确的绝对资源路径。重要数据应逐步写入 `outputDir`，不要只在任务结束时保存。

## 开始一个常驻操作

先按[操作指南](docs/FAST-OPERATIONS.md)准备范围明确的 `start.json`，包含用户选定的浏览器、账号与资源证据、允许动作和有效期。配置示例本身不构成真实账号操作授权。

```bash
taskmaster ops start --input '@start.json' --json
taskmaster ops command OP_ID --input '@observe.json' --json
taskmaster ops get OP_ID --json
taskmaster ops events OP_ID --after CURSOR --wait-ms 30000 --json
taskmaster ops takeover OP_ID --json
taskmaster ops stop OP_ID --json
```

命令返回持久受理记录，实际完成情况要读取对应回复。保留操作 ID 和事件游标；断线后先检查当前状态与未决动作，再继续。`ops stop-all` 只停止常驻操作，不影响无关脚本任务，也不能撤销服务端已经接受的动作。

## 人工验证与结果保留

- 脚本可以进入 `wait({ reason: 'verification' })`：保留 Chrome、请求桌面通知并拍摄有限的诊断截图；20 分钟后暂停，要求人工恢复。
- 页面是否可以继续，由 Agent 或用户判断；任务大师不会自动破解验证码，也不会猜测验证已经解除。
- 结束的任务卡片会离开 Dashboard，但记录和输出仍可通过 CLI 读取，直到明确删除。
- **清理空间**保留登录态、扩展数据和活动任务；历史输出是需要单独勾选的删除类别。

## 已经验证到哪里

可选在线 Codex CLI 适配器于 2026-11-15 完成 Windows 隔离环境下的一次四小时验收：**14,401,755.9 毫秒**、**238 次采样**、最大采样间隔 **61.01 秒**。两次新的真实 CLI Agent 调用分别完成中断投递后的只读观察，以及拒绝未授权发布并安全停止。适配器空闲模型调用为零，模拟业务写入为零，隔离环境清理通过。定时进入断言复用了此前证据，适配器与核心哈希保持不变，没有复用此前运行时长。

这是源码环境、宿主在线条件下的证据，**不证明**原桌面聊天会被唤醒、电脑休眠或宿主关闭后的恢复、真实平台业务写入，或各平台安装包已经通过。原生安装包、便携包和公开下载文件各自有独立发布验证，详见 [4.0.0 发布说明](docs/releases/4.0.0.md)及[适配器证据与边界](docs/CODEX-HOST-ADAPTER.md)。

## 信任与安全边界

任务脚本是以当前系统用户权限运行的可信本机代码，不是安全沙箱；可以访问网络与文件系统，只运行你信任的 Agent、Skill 和脚本。常驻操作的安全约束不会把任意脚本变成受限代码。

Manager 仅监听 `127.0.0.1`，对自身诊断做敏感信息脱敏，不自动重放整个失败脚本。分享前仍应检查任务生成的文件与截图。模式、计划、页面指令或适配器回执都不能授予新权限；无法测量的 token 或费用，不能宣称已实现支出控制。

## 一起构建和分享 Skill

[Task Master Skills 社区库](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill)用于分享可复用的流程说明、脚本和结果核验。Skill 不是必需品：先用小脚本把工作做通，再沉淀确实有效的部分。

欢迎提交[工作流想法](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/issues/new?template=skill-proposal.md)，或按[贡献指南](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/blob/main/CONTRIBUTING.md)参与。运行时保持通用，专业工作流独立演进。

## 许可证

MIT
