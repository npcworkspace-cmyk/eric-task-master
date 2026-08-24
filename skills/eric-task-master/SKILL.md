---
name: eric-task-master
description: Install, connect, and use Eric Task Master for durable Playwright browser work with isolated persistent profiles, MCP task control, progress, recovery, artifacts, optional human behavior, and specialized task modules.
---

# Eric Task Master

Task Master is the browser execution layer. Playwright performs browser work in isolated persistent Profiles. The everyday-browser extension only manages Profiles and performs a user-approved, current-site session transfer.

## One fixed startup

From the cloned project root or this Skill directory, run exactly:

```bash
node scripts/taskmaster.mjs connect --json
```

First use is incomplete until `connect` returns `ok: true`. It installs lockfile-pinned dependencies and Chromium when missing, starts Manager, runs the real-browser acceptance suite, and safely registers the same STDIO MCP server in every detected supported Agent host.

If registration reports `registered_pending_restart`, ask the user to restart or reload that Agent host once. Do not invent ports, daemons, browser flags, config formats, or alternate controllers. If startup fails, retry this same command once, then report its exact `error.code` and `nextAction`.

After the host reload, call `taskmaster_status`. MCP starts Manager automatically when it is not running. Then call `taskmaster_profiles_list`. Create a Profile only if no suitable one exists because profile creation is non-idempotent.

## Run tasks through MCP

Use these high-level tools instead of reconstructing HTTP or Playwright control:

1. `taskmaster_task_types_list` to discover installed task contracts.
2. `taskmaster_tasks_start` with a stable, unique `idempotencyKey`.
3. Keep the returned `taskId`.
4. Use `taskmaster_tasks_wait` for bounded waits or `taskmaster_tasks_get` for a snapshot.
5. If a failed task has a checkpoint and settled cleanup, inspect its progress and diagnostics, then call `taskmaster_tasks_resume` on the same task ID with one stable `resumeKey`.
6. Use `taskmaster_artifacts_list` and bounded `taskmaster_artifacts_read` for declared results.

A cancelled MCP wait does not cancel the durable task. Only `taskmaster_tasks_cancel` cancels it. Never submit a replacement merely because an Agent disconnected; retrieve the original task by ID first.

Resume is always explicit and idempotent. Reuse the same `resumeKey` when retrying the same resume request; use a new key only for a deliberately new attempt. Before resume, inspect the checkpoint, progress, error, and current site state. Never assume an external click, submission, message, or purchase failed merely because its response was lost.

Default to `fast` for deterministic and data-heavy work. Use `human` only when the user or workflow requests paced pointer, typing, hover, scrolling, and reading. Use `adaptive` when a dynamic site may require the task module to signal timeouts, occlusion, navigation uncertainty, or rate limiting. In a custom task, call `action.read({ words })` only after observing content the workflow actually intends to read; do not add invented dwell to bulk collection.

The worker emits heartbeats automatically and task modules report meaningful progress. A delayed heartbeat triggers a diagnostic screenshot before failure. Every action failure and task timeout also attempts a screenshot. Treat the screenshot reference as diagnostic evidence, not proof that an external action succeeded.

## Specialized Skills and disposable modules

If a specialized Skill matches the site or workflow, follow that Skill for discovery, pagination, parsing, rate-limit policy, checkpoints, and completion evidence. It must use Task Master as its execution layer; it must not duplicate Manager, Profile, MCP, progress, or cleanup logic.

When no task type exists, create one bounded, single-file `.mjs` module using [references/task-runtime.md](references/task-runtime.md). Register it with the fixed launcher; Task Master copies it into a Manager-owned inbox, verifies it, and snapshots it before execution. Site selectors and business logic belong there, never in this base Skill.

For authenticated work, follow [references/profiles-and-sessions.md](references/profiles-and-sessions.md). Never request, print, persist, or return cookies, tokens, authorization headers, Manager credentials, or browser-profile files.

## Completion gate

Claim completion only when the original task is terminal, cleanup has settled, and its compact evidence plus declared artifacts prove the requested outcome. Manager independently rejects a Worker completion claim when the result is malformed, a declared Agent-visible artifact is missing or unstable, the browser did not close, the Worker did not exit, or the Profile lease was not released. A module return value is not a data stream; large JSONL, CSV, screenshots, and downloads must be declared artifacts.
