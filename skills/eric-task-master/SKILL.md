---
name: eric-task-master
description: Install, connect, and use Eric Task Master for durable Playwright browser jobs with persistent or ephemeral Profiles, adaptive behavior, task queues, progress health, semantic diagnostics, recovery, artifacts, and composable Task Packs.
---

# Eric Task Master

Task Master is the browser execution layer. Use its registered high-level task types; do not invent another daemon, port, controller, browser launcher, or task-follow loop.

## Fixed startup and acceptance

From the cloned project root or this Skill directory, run exactly:

```bash
node scripts/taskmaster.mjs connect --json
```

Installation is incomplete until this command returns `ok: true` and its real-browser acceptance checks pass. It installs lockfile-pinned dependencies and Chromium when missing, starts Manager, and safely registers STDIO MCP in detected supported Agent hosts. If it reports `registered_pending_restart`, ask the user to reload that Agent host once. If startup fails, retry this same command once, then report the exact `error.code` and `nextAction`; do not branch into speculative controllers.

After reload, call `taskmaster_status`, then `taskmaster_profiles_list`. Create a Profile only when no suitable one exists because creation is non-idempotent:

- choose `persistent` for login state or recurring account work;
- choose `ephemeral` for no-login temporary work. It starts clean for every task and retains no browser state after cleanup. It cannot receive session transfer or be opened manually.

## Fixed task loop

1. Call `taskmaster_task_types_list` with a narrow `query`, `domain`, or `intent`. This returns compact summaries only.
2. Call `taskmaster_task_types_describe` for the one selected type and construct input from that schema.
3. Call `taskmaster_tasks_start` once with a stable unique `idempotencyKey`; keep the returned task ID.
4. Call `taskmaster_tasks_wait` repeatedly, or `taskmaster_tasks_get` for a snapshot. A cancelled wait does not cancel the durable task.
5. If state is `waiting_user`, list/read the diagnostic screenshot and semantic-observation artifacts, inspect current state, then call `taskmaster_tasks_continue` with the matching request ID. This continues the same live task.
6. If health is `stalled`, read diagnostics. Do not submit a duplicate. The controller will fail and clean up the task if meaningful progress remains silent past its hard deadline.
7. If a failed task exposes a checkpoint and settled cleanup, inspect its error, checkpoint timestamp, diagnostics, and current site state; then call `taskmaster_tasks_resume` on the same ID with one stable `resumeKey`.
8. Claim completion only when the task is terminal, cleanup is settled, and its compact evidence plus declared artifacts prove the requested outcome.

Same-Profile tasks queue in FIFO order; different Profiles may run concurrently within the Manager resource budget. Queueing is normal, not a reason to retry.

## Behavior choice

- `fast`: deterministic Playwright with minimum necessary waiting. Default for stable, data-heavy work.
- `human`: bounded pointer curves, in-target clicks, typing rhythm, eased scrolling, and explicit reading dwell.
- `adaptive`: starts fast, uses a brief cautious tier for ordinary dynamic content, and temporarily uses guarded human pacing after occlusion, timeout, uncertain navigation, action failure, or rate limiting. It returns to fast after successful actions and never auto-replays an unknown effect.

The task status exposes configured/effective behavior and active cooldown timing. Human-like pacing is a reliability option, not a promise to evade website controls or protect an account from platform enforcement.

## Diagnostics and handoff

Action failure, task timeout, delayed heartbeat, stalled progress, and explicit `handoff.request()` all trigger a bounded viewport screenshot plus a bounded semantic observation when the page is available. Prefer the semantic artifact first because it is smaller and gives stable refs, roles, names, text, and frame context; use the screenshot for visual ambiguity.

The Worker emits liveness heartbeats automatically. Task modules must still report meaningful progress after each externally verifiable unit. Manager distinguishes “process alive” from “work advancing,” wakes bounded waits with attention states, captures diagnostics on silence, and closes every task window during terminal cleanup.

## Specialized Skills and Task Packs

If a specialized Skill matches, follow it for site discovery, selectors, pagination, parsing, rate-limit policy, checkpoints, outputs, and evidence. It should call Task Master task types rather than duplicate the base runtime.

When no task type exists, read [references/task-runtime.md](references/task-runtime.md). For one disposable job, register one bounded `.mjs` task. For reusable capability, read [references/task-packs.md](references/task-packs.md) and ship a versioned Task Pack. Task Pack installation is transactional: a conflict rejects the whole Pack without partial registration.

For account work, read [references/profiles-and-sessions.md](references/profiles-and-sessions.md). Never request, print, persist, or return cookies, tokens, authorization headers, Manager credentials, or browser-profile files.
