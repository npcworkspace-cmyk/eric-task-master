# Eric Task Master 3.00

**One task. One small script. One command.**

Eric Task Master is an always-on local Chrome task system for AI agents. It gives Codex, Claude Code, WorkBuddy, Hermes, Pi, and any other local Agent with terminal access a shared way to start long-running browser work, stream partial results, and leave the task running after the Agent disconnects.

[中文说明](README.zh-CN.md)

## Why

Built-in Agent browsers are short-lived. Direct browser control is flexible but usually loses task state, progress, and cleanup when an Agent turn ends. Task Master keeps that operational layer running while leaving the actual browser logic completely free.

- **Fast start:** write the smallest useful `.mjs`, then run one command.
- **Full browser freedom:** use Playwright, `page.evaluate()`, CDP, HTTP, files, and your own retry logic directly.
- **Durable work:** the Manager and Worker continue after the calling Agent exits.
- **Real signed-in sessions:** named persistent Profiles use the computer's stable Chrome.
- **Multi-Agent ready:** different Profiles run concurrently; one Profile has one writer at a time.
- **Results while running:** progress and output files remain useful even when a task stops early.
- **Simple recovery:** stale leases are reclaimed; stop and delete terminate owned processes and release the Profile.
- **Quiet local operation:** CLI only, loopback only. No MCP registration, browser extension, pairing code, or task-asset catalog.

Use it for unattended research, recurring operations, long browser collections, account workflows, form work, monitoring, content operations, QA, or any custom web process an Agent can express in JavaScript.

## Install

Download two files from the [latest GitHub Release](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest):

1. the Manager package for Windows, macOS, or Linux;
2. `eric-task-master-skill-v3.0.1.zip`.

The Manager package includes its Node.js runtime, Playwright runtime, CLI, Dashboard, and background service. It uses an installed stable Google Chrome and does not download a separate Chromium.

After installation:

```bash
taskmaster panel
```

Create a Profile, sign in once in its visible Chrome window, and set it as default. Then give the Skill to the Agent and state the task.

## Agent path

```bash
taskmaster run ./job.mjs --input '@./input.json' --detach --json
taskmaster follow TASK_ID --json
```

Omit `--profile` to use the default Profile. `run` starts the local Manager automatically when needed.

Minimal task:

```js
export async function run({ page, input, outputDir, progress, signal }) {
  await page.goto(input.url, { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  await progress({ current: 1, total: 1, message: 'Collected title' });
  return { title, outputDir, aborted: signal.aborted };
}
```

The script receives the real Playwright `page`, `context`, and `browser`. It may use direct Playwright APIs, evaluate JavaScript, open CDP sessions, perform HTTP requests, and write incremental results to `outputDir`.

The submitted `.mjs` entry is the only file frozen into the task directory. Keep it self-contained: use Node built-ins, bare `playwright`, task `input`, absolute paths, or `outputDir`; relative sibling imports and resources beside the Agent's source file are not copied.

## Essential commands

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

## Trust model

Task scripts run as the current operating-system user and are trusted local code. Task Master does not pretend to sandbox them. Run scripts and Skills only from sources you trust.

Task Master itself binds to `127.0.0.1`, redacts credentials from Manager-owned diagnostics, never automatically replays an entire failed script, and never launches two writers against the same Profile directory.

## Project principle

Every design decision is judged against one path:

> **Receive the task → write the smallest free script → run one CLI command → stream useful results.**

If a feature adds a required step before the first browser action without improving process safety or durability, it does not belong in the Manager.

## License

MIT

Keywords: AI agent browser automation, Playwright automation, Chrome automation, long-running agent tasks, unattended automation, local AI agent, browser profile manager, CLI automation, multi-agent automation, RPA, web research, data collection.
