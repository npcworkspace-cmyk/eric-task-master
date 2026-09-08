# Eric Task Master

**Keep the task running after the Agent leaves the chat.**

Eric Task Master is an always-on local browser task foundation. The Agent understands the goal and writes the smallest useful script; Task Master keeps real Chrome sessions, processes, progress, and outputs running beyond a single Agent turn. It does not replace the Agent or lock work into a fixed workflow—it turns temporary browser actions into durable, parallel, and reusable automation.

Codex, Claude Code, WorkBuddy, Hermes, Pi, and any other Agent that can run a local CLI and read JSON can use the same interface.

English | [简体中文](README.zh-CN.md) | [Latest Release](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest) | [Task Master Skills](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill) | **[NPC Website ↗](https://www.npctech.site/)**

Built by **NPC**. [Explore our work, services, and AI tools →](https://www.npctech.site/)

## What Agents can do with it

- **Long research and data collection:** search, read, organize, and persist results across many pages without depending on one Agent turn.
- **Unattended batch work:** keep a bounded script running in the background or overnight with its own pacing, checkpoints, and recovery logic.
- **Multiple accounts and workspaces:** retain each signed-in session in a separate Chrome Profile and let different Agents use different Profiles concurrently.
- **Web operations and repetitive workflows:** automate back-office entry, forms, content processes, product work, and account workflows through a task-specific script or Skill.
- **Monitoring, inspection, and QA:** observe page changes, verify workflows, record exceptions, and make intermediate results available while the task is still running.
- **Reusable professional capabilities:** package a proven script, domain rules, and result checks as a Skill that other Agents and computers can reuse.

It is designed for web work with a clear objective that needs real Chrome, may run for a long time, and must not lose its results. A new idea can start as a disposable script; a proven workflow can grow into a reusable Skill.

## Why not only use an Agent's built-in browser

Built-in Agent browsers are excellent for immediate interaction, but they are not designed to own long-running, recoverable work with persistent identity. Direct Playwright is flexible, but every Agent then has to rebuild process management, Profiles, progress, output, and cleanup.

Task Master supplies that missing operational layer:

- **The Agent can exit while the job continues:** the local Manager and Worker keep running.
- **Sign in once and reuse the session:** named Profiles use the computer's stable Chrome and preserve browser state.
- **Multiple Agents can work without fighting for one window:** different Profiles run concurrently; each Profile has one writer at a time.
- **Results arrive during execution:** progress and files remain readable even if a task stops before reaching its full target.
- **Human verification does not destroy the task:** Chrome stays open, the user is notified, and work can resume from the retained session.
- **Lifecycle cleanup is built in:** stop and delete terminate owned processes, release Profiles, and reclaim stale leases only after old process inactivity is confirmed.

## One foundation, three levels of use

### 1. Manager: the durable execution layer

The Manager owns browser processes, Profile leases, task state, progress, output files, stop, resume, and cleanup. A human sees current work in the local Dashboard; Agents operate the same state through the CLI.

### 2. `.mjs`: the fastest free-form task

For a new request, the Agent writes the smallest useful JavaScript file and runs it immediately. The script can use Playwright, `page.evaluate()`, CDP, HTTP, local files, custom concurrency, pacing, retries, and checkpoints directly. The Manager does not impose another browser-action framework.

### 3. Skill: a reusable professional capability

Once a workflow proves useful, its instructions, task script, business rules, and result checks can become a Skill. Task Master stays general while vertical capabilities evolve independently, so the core never has to absorb every website and business process.

The layers work independently or together: run a small script for a one-off need, use a dedicated Skill for established work, and let both share the same durable execution foundation.

## Platform value

Task Master is intended to be more than a way to control one browser. It is a local task execution platform shared by multiple Agents:

- **One common entry point:** terminal-capable Agents use the same CLI without a host-specific plugin or protocol.
- **Tasks are independent of conversations:** the Manager owns the job after submission; the originating chat does not need to stay alive.
- **Capabilities are independent of the core:** business changes update a script or Skill instead of continually expanding the Manager.
- **Open result files:** outputs remain ordinary files that can be analyzed, audited, transformed, and delivered by other tools.
- **Less repeated work:** reusing signed-in state, task state, and specialized Skills reduces the time and tokens spent re-reading pages, rebuilding context, and rewriting controllers.
- **A path from one-off work to scale:** validate with a minimal script, then preserve high-value workflows as Skills and build a personal or team automation library.

The same foundation can support web research, data collection, content and account workflows, e-commerce administration, lead development, page monitoring, browser QA, and other work an Agent can express in JavaScript.

## How it works

```text
Reusable Skill ─┐
Disposable .mjs ├─> Agent ─> taskmaster CLI ─> local Manager ─> Worker ─> Chrome Profile
Natural language┘                              │
                                               └─> progress, events, result files

Human ───────────────────────────────> local Dashboard: task control and Profile management
```

Agent-to-Manager communication is a local CLI with machine-readable JSON:

1. `run --detach` submits the script and input, then returns a task ID immediately;
2. `follow` reads progress, state, and an event cursor;
3. `files` lists task artifacts, and `files --read` reads a selected result file;
4. `stop`, `resume`, and `delete` control the task lifecycle.

The Manager binds only to `127.0.0.1`. There is no MCP registration, browser extension, pairing code, or separate controller installation for each Agent.

## Deploy in three steps

### Step 1: install the Manager

Install stable Google Chrome first. Then download two files from the [latest GitHub Release](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest):

1. the Manager installer **or portable ZIP** matching the operating system and CPU;
2. `eric-task-master-skill-v<VERSION>.zip`.

| Platform | Installer | Portable package |
| --- | --- | --- |
| Windows 10/11 x64 | `eric-task-master-v<VERSION>-windows-x64-setup.exe` | `eric-task-master-v<VERSION>-windows-x64-portable.zip` |
| macOS Apple silicon | `eric-task-master-v<VERSION>-macos-arm64.pkg` | `eric-task-master-v<VERSION>-macos-arm64-portable.zip` |
| macOS Intel | `eric-task-master-v<VERSION>-macos-x64.pkg` | `eric-task-master-v<VERSION>-macos-x64-portable.zip` |
| Debian/Ubuntu x64 | `eric-task-master-v<VERSION>-linux-x64.deb` | `eric-task-master-v<VERSION>-linux-x64-portable.zip` |
| Debian/Ubuntu arm64 | `eric-task-master-v<VERSION>-linux-arm64.deb` | `eric-task-master-v<VERSION>-linux-arm64-portable.zip` |

The package includes Node.js, Playwright, the CLI, local Dashboard, and an on-demand background Manager. Users do not configure Node.js or download a separate Chromium.

If the installer is unavailable, download `eric-task-master-v<VERSION>-<target>-portable.zip` and `SHA256SUMS` from the same Release, verify the archive, and extract it into a permanent directory:

```powershell
# Windows
& 'C:\Tools\eric-task-master\bin\taskmaster.cmd' panel
```

```bash
# macOS / Linux
'/absolute/path/eric-task-master/bin/taskmaster' panel
```

Portable packages need no administrator access or system Node.js. Current Windows and macOS packages are unsigned, so the operating system may ask the user to approve them; a portable ZIP does not bypass SmartScreen or Gatekeeper. See the [installation guide](docs/INSTALLERS.md) for target selection, upgrades, and compatibility details.

### Step 2: prepare the default Profile

Run:

```bash
taskmaster panel
```

Create a Profile in the Dashboard, open its native Chrome window, and sign in. Close the window, then make that Profile the default. Automated tasks reuse the same browser state. Individual sites may still request verification later.

### Step 3: give the Skill to the Agent

Import `eric-task-master-skill-v<VERSION>.zip` with the Agent's Skill manager. For folder-based installation, extract it first and confirm that `SKILL.md` is at the Skill root. If the Agent has no Skill mechanism, give it this repository and ask it to read `skills/eric-task-master/SKILL.md`.

From then on, state the task. The Agent follows one fixed path: write the smallest `.mjs`, run it once, return the Dashboard URL, and keep following useful results.

## The fixed Agent path

```bash
taskmaster run ./job.mjs --input '@./input.json' --detach --json
taskmaster panel --json
taskmaster follow TASK_ID --wait-ms 60000 --json
taskmaster files TASK_ID --json
```

The first `follow` call needs no cursor. On later calls, continue with the returned `after` value: `taskmaster follow TASK_ID --after AFTER --wait-ms 60000 --json`. Omit `--profile` to use the default Profile selected in the Dashboard. `run` starts the Manager in the background when needed. Every command supports `--json`, giving different Agents the same stable interface.

`panel --json` returns the fixed Dashboard link without opening a browser. Reuse that link across tasks; use `taskmaster panel` only to explicitly open the panel. Task browser windows close when their task ends; a manually opened Dashboard stays open.

Minimal task:

```js
export async function run({ page, input, outputDir, progress, signal }) {
  await page.goto(input.url, { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  await progress({ current: 1, total: 1, message: 'Collected title' });
  return { title, outputDir, aborted: signal.aborted };
}
```

Only the submitted `.mjs` entry is frozen. Keep it self-contained: use Node.js built-ins, bare `playwright`, task `input`, absolute paths, or `outputDir`. Relative sibling imports and resources beside the source entry are not copied automatically.

## Essential commands

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

## Long work, verification, and results

- Task scripts should write valuable data incrementally under `outputDir` instead of saving everything only at the end.
- `progress()` reports the current action and processed count; `follow` continues from its event cursor after an Agent reconnects.
- When a script detects a verification page, it can call `wait({ reason: 'verification' })`. The Manager retains Chrome and the Worker, notifies the user, captures diagnostic screenshots, and automatically pauses with the session retained after a bounded wait.
- The Agent or human can resume the task; during screenshot probes, the Agent resumes against the current `probeId` returned by `follow`. Task Master does not automatically identify or solve CAPTCHAs.
- The Dashboard shows only current queued, running, waiting, and stopping work. Terminal cards disappear automatically, while records and outputs remain readable through the CLI or available for explicit cleanup.
- **Clean space** clears idle Profile caches and finished-task temporary scripts. Historical output is a separate opt-in; signed-in state, extension data, and active work are preserved.

## Why it stays maintainable and extensible

- **A thin core:** the Manager owns tasks, processes, Profiles, progress, and results—not website-specific rules.
- **Clear upgrade boundaries:** application files are stored separately from Profiles, signed-in state, task records, and outputs.
- **A consistent runtime:** each release packages the Node.js and Playwright versions it has verified, reducing dependency drift across Agent hosts.
- **No script registration:** a new one-off task runs directly and does not become an asset or Task Type to maintain.
- **Skills evolve separately:** website adapters, domain knowledge, and result validation can be released, replaced, and reused independently.
- **One cross-platform contract:** Windows, macOS, and Linux use the same CLI and task-file model.

## Task Master Skills community

Looking for a workflow an Agent can use now? Visit the [Task Master Skills library](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill) for creator discovery, community research, and other capabilities. A Skill can include the working instructions, task script, and result checks for a specific job. Skills are optional; any trusted script can still run directly.

Have a workflow that saves time? Package its useful parts as a Skill. Start with a [workflow idea](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/issues/new?template=skill-proposal.md), improve an existing Skill, or follow the [contribution guide](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/blob/main/CONTRIBUTING.md) to prepare a pull request. Reviewed contributions can become downloadable releases that others can install and use.

Our goal is to let one person and their Agents organize large batches of useful work. Every shared workflow, tested fix, and clearer instruction helps the next person automate more and makes personal or small-team automation increasingly practical.

**The two projects have separate roles:**

- [Eric Task Master](https://github.com/npcworkspace-cmyk/eric-task-master): the durable local task execution foundation.
- [Task Master Skills](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill): a place to find, build, and share reusable professional workflows.

## Trust model

Task scripts run as trusted local code with the current operating-system user's permissions. Task Master does not pretend to provide a security sandbox. Run only Agents, Skills, and scripts you trust.

The Manager control plane binds to local `127.0.0.1`, redacts credentials from Manager-owned diagnostics, never automatically replays an entire failed script, and never launches two writers against the same Profile directory. Task scripts themselves have network and filesystem access; their actual behavior remains the script author's responsibility.

## Project principle

> **Receive the task → write the smallest free script → run one CLI command → stream useful results.**

If a feature cannot make work start faster, run more reliably, or finish more cleanly—but adds a required step before the first browser action—it does not belong in the Manager.

## License

MIT

Keywords: AI agent browser automation, AI automation platform, Playwright automation, Chrome automation, long-running Agent tasks, unattended automation, local AI Agent, multi-Agent automation, browser Profile manager, CLI automation, RPA, web research, data collection, workflow Skills, cross-platform Agent tools.
