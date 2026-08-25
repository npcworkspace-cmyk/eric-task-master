---
name: eric-task-master
description: Install, connect, and use Eric Task Master for durable Playwright browser jobs with persistent or ephemeral Profiles, adaptive behavior, task queues, progress health, semantic diagnostics, recovery, artifacts, and composable Task Packs.
---

# Eric Task Master

Task Master is the browser execution layer. Use its registered high-level task types; do not invent another daemon, port, controller, browser launcher, or task-follow loop.

## Fixed GitHub-to-task bootstrap

This Skill is the instruction adapter, not the browser runtime. It requires the complete `eric-task-master` repository. When the user supplies the GitHub URL, authenticate if needed, clone the full repository, and read or install this Skill from `skills/eric-task-master`. If this Skill is installed elsewhere, set `ERIC_TASK_MASTER_ROOT` to that clone.

From the cloned project root run exactly:

```bash
node scripts/taskmaster.mjs connect --json
```

Installation is incomplete until this command returns `ok: true` and its real-browser acceptance checks pass. It installs lockfile-pinned dependencies and Chromium when missing, safely migrates an idle authenticated older Manager, starts Manager, and registers STDIO MCP in detected supported Agent hosts. A busy older Manager returns `MANAGER_UPGRADE_BUSY` without interrupting its work; wait for it to settle and rerun the same command once. For any other startup failure, follow the exact `error.code` and `nextAction`, retry the same command at most once after fixing that precondition, and do not branch into speculative controllers.

If the extension is already installed from the current checkout, reload it only after a version update. Otherwise load the repository's `extension/` directory. Ask the user to paste the returned `ETM1...` code and click **Pair**; never attempt to approve pairing for them.

If registration reports `registered_pending_restart`, ask the user to reload that host once. Then call `taskmaster_status`, followed by `taskmaster_profiles_list`. When both succeed, ask what browser task to run. Create a Profile only when no suitable one exists because creation is non-idempotent:

- choose `persistent` for login state or recurring account work;
- choose `ephemeral` for no-login temporary work. It starts clean for every task and retains no browser state after cleanup. It cannot receive session transfer or be opened manually.

An Agent-created Profile is private to that stable Agent client ID by default. Set `access: "shared"` only when the user explicitly wants other registered local Agents to use the same browser state. Sharing a Profile never shares task status, results, or artifacts.

Treat one registered MCP client ID as one local Agent principal. Different registered hosts/client IDs are isolated; parallel conversations using the same host registration intentionally share that principal's task ledger. Use a distinct registration/client ID when strict tenant separation is required.

## Fixed task loop

1. Call `taskmaster_task_types_list` with a narrow `query`, `domain`, or `intent`. This returns compact summaries only.
2. Call `taskmaster_task_types_describe` for the one selected type and construct input from that schema.
3. Call `taskmaster_tasks_start` once with a stable unique `idempotencyKey`; keep the returned task ID.
4. Call `taskmaster_tasks_wait` repeatedly, or `taskmaster_tasks_get` for a snapshot. A cancelled wait does not cancel the durable task.
5. If state is `waiting_user`, list/read the diagnostic screenshot and semantic-observation artifacts, inspect current state, then call `taskmaster_tasks_continue` with the matching request ID. This continues the same live task.
6. If health is `stalled`, read diagnostics. Do not submit a duplicate. The controller will fail and clean up the task if meaningful progress remains silent past its hard deadline.
7. If a failed task exposes a checkpoint and settled cleanup, inspect its error, checkpoint timestamp, diagnostics, and current site state; then call `taskmaster_tasks_resume` on the same ID with one stable `resumeKey`.
8. Claim completion only when state is `completed` (a state Manager publishes only after completion verification), cleanup is settled, and its compact evidence plus declared artifacts prove the requested outcome. A `failed`, `cancelled`, or integrity-invalid task has no publishable business result even if files remain in its private output directory.

Same-Profile tasks queue in FIFO order; different Profiles may run concurrently within the Manager resource budget. Queueing is normal, not a reason to retry.

## Behavior choice

- `fast`: deterministic Playwright with minimum necessary waiting. Default for stable, data-heavy work.
- `human`: bounded pointer curves, in-target clicks, typing rhythm, eased scrolling, and explicit reading dwell.
- `adaptive`: starts fast, uses a brief cautious tier for ordinary dynamic content, and temporarily uses guarded human pacing after occlusion, timeout, uncertain navigation, action failure, or rate limiting. It returns to fast after successful actions and never auto-replays an unknown effect.

The task status exposes configured/effective behavior and active cooldown timing. Human-like pacing is a reliability option, not a promise to evade website controls or protect an account from platform enforcement.

## Diagnostics and handoff

Action failure, task timeout, delayed heartbeat, stalled progress, and explicit `handoff.request()` request a bounded viewport screenshot plus a bounded semantic observation when the Worker and page are still responsive. The automatic screenshot is a complete JPEG preview that fits one maximum-size artifact read; do not assemble or display partial image chunks. Prefer the semantic artifact first because it is smaller and gives stable refs, roles, names, text, and frame context; use the screenshot for visual ambiguity. Absence of a diagnostic is not proof that the page was healthy.

The Worker emits liveness heartbeats automatically. Task modules must still report meaningful progress after each externally verifiable unit. Manager distinguishes “process alive” from “work advancing,” wakes bounded waits with attention states, requests diagnostics on silence, and requires proof that every task browser closed. If closure cannot be confirmed, cleanup stays unsettled and the Profile remains blocked; never submit a replacement task on that Profile.

Stop Manager only through `node scripts/taskmaster.mjs manager stop --json`. If a hard operating-system stop or power loss leaves cleanup unproved, report the affected Profile as quarantined and do not kill or reuse a process solely from a persisted PID.

## Specialized Skills and Task Packs

If a specialized Skill matches, follow it for site discovery, selectors, pagination, parsing, rate-limit policy, checkpoints, outputs, and evidence. It should call Task Master task types rather than duplicate the base runtime.

When no task type exists, read [references/task-runtime.md](references/task-runtime.md). For one disposable job, register one bounded `.mjs` task. For reusable capability, read [references/task-packs.md](references/task-packs.md) and ship a versioned Task Pack. Task Pack installation is transactional: a conflict rejects the whole Pack without partial registration.

For account work, read [references/profiles-and-sessions.md](references/profiles-and-sessions.md). Never request, print, persist, or return cookies, tokens, authorization headers, Manager credentials, or browser-profile files.
