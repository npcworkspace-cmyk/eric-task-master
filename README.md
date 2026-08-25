# Eric Task Master

[English](./README.md) | [简体中文](./README.zh-CN.md)

**A durable browser automation task system for AI agents.**

Version: **1.0.4**

AI agents can reason, plan, and write code, but browser execution is often their weakest link. Built-in agent browsers are convenient for short sessions yet commonly lose login state, task continuity, and recovery context. Thin CDP controllers offer fast low-level access, but leave every Agent to rebuild orchestration, progress tracking, cleanup, and error recovery for each job.

Eric Task Master fills that gap. It is a Playwright-first browser automation runtime that turns web work into durable, isolated, observable jobs. An Agent can start a task, leave it running for hours, reconnect later, inspect evidence, recover from a checkpoint, and verify that the browser closed—without occupying the user's everyday browser or repeatedly spending tokens rediscovering the same execution mechanics.

`AI agent` · `browser automation` · `Playwright` · `MCP server` · `web automation` · `computer use` · `workflow automation` · `browser agent` · `headless browser` · `multi-agent automation`

## What can an Agent build with it?

Task Master is a general execution base, not a site-specific bot. Combined with an Agent, a specialized Skill, or a Task Pack, it can support:

- unattended research, monitoring, and source-backed web collection;
- long-running batch work across hundreds of pages without keeping an Agent turn open;
- authenticated back-office, portal, CMS, CRM, and account workflows through isolated persistent Profiles;
- clean no-login jobs through disposable ephemeral Profiles;
- parallel multi-Agent operations without tabs, login state, or task records colliding;
- recurring operational workflows invoked by an Agent, scheduler, or business system;
- browser QA, content verification, form processing, file upload/download, and evidence capture;
- production Task Packs for lead operations, ecommerce operations, media research, supplier research, customer support, compliance checks, or internal RPA.

Those are composable possibilities, not bundled permissions or claims that every website is supported. Task Master supplies the reliable browser runtime; a specialized Skill or Task Pack supplies the business logic, site policy, parsing, checkpoints, outputs, and completion evidence.

## Why not just use an Agent browser or a CDP script?

| Approach | Good at | What is usually missing |
| --- | --- | --- |
| Built-in Agent browser | quick interactive browsing | durable jobs, reusable login Profiles, long-task recovery, multi-Agent isolation, explicit cleanup proof |
| One-off CDP controller | fast raw browser control | a stable lifecycle, queues, progress, checkpoints, evidence, resumability, reusable task contracts |
| Eric Task Master | production-shaped browser work | site-specific knowledge, intentionally supplied by Skills and Task Packs |

Task Master does not replace Agent reasoning. It gives that reasoning a dependable pair of browser hands.

## The three-layer model

1. **Task Master runtime** — pure Playwright execution, persistent and ephemeral Profiles, queues, durable tasks, progress, recovery, evidence, and cleanup.
2. **Real-browser control panel** — the Chromium extension manages Profiles, opens the Dashboard, and transfers the current site's login only after an explicit user click. It never becomes the page-automation engine.
3. **MCP + Skills + Task Packs** — Agents receive a compact, high-level task interface while reusable domain capabilities stay independent from the core runtime.

This separation keeps the base universal: improve one execution engine, then define many specialized automation workers above it.

## For AI Agents: one fixed bootstrap protocol

If a user gives you this GitHub URL, follow the steps below in order. Do not invent another daemon, port, browser launcher, controller, or retry loop.

> The full repository is the runtime source of truth. The Skill-only archive is an instruction adapter and cannot run without a cloned `eric-task-master` repository.

1. Authenticate to GitHub if the repository is private, then clone the complete repository.
2. Require Node.js 20 or newer.
3. Read `skills/eric-task-master/SKILL.md`. Install that folder into the host's Skill directory when the host supports Skills; otherwise follow it in place.
4. From the repository root run exactly:

   ```bash
   node scripts/taskmaster.mjs connect --json
   ```

5. `connect` installs the lockfile-pinned runtime and matching Playwright Chromium, safely migrates an idle older Manager, starts the loopback Manager, runs real-browser acceptance, and registers supported local MCP hosts. If an older Manager still has work, migration stops without interrupting it.
6. Follow the returned `nextAction`. After correcting the named precondition, retry the same command at most once; do not branch into a speculative replacement controller.
7. If the Chromium extension is already installed from this checkout, reload it after a version update. Otherwise load [`extension/`](./extension/) as an unpacked extension.
8. Ask the user to paste the returned one-time `ETM1...` code into the extension and click **Pair**. This is the only required human authorization in the normal bootstrap.
9. If a host reports `registered_pending_restart`, ask the user to reload that Agent host once.
10. Call `taskmaster_status`, then `taskmaster_profiles_list`. When both succeed, ask the user what browser task to run.

Copyable request for a new Agent:

> Install and start `https://github.com/npcworkspace-cmyk/eric-task-master`. The Chromium extension is already installed. Clone the full repository, read or install `skills/eric-task-master`, and run only `node scripts/taskmaster.mjs connect --json`. Do not invent another controller or port. Ask me only when the extension pairing code is ready; after status and Profile discovery succeed, ask what task I want to run.

## Everyday use

After the first bootstrap, the user should be able to ask naturally:

> Use Eric Task Master with an ephemeral Profile and adaptive behavior to research these sites, report progress, save evidence, and close every task window when finished.

The Agent then uses one durable loop: discover a task type, start once with an idempotency key, retain the task ID, wait or reconnect to that ID, inspect diagnostics when attention is required, and accept completion only after evidence and cleanup are verified.

### Profiles

- **persistent** — isolated reusable state for logged-in and recurring work;
- **ephemeral / 隐身临时** — a clean non-persistent browser for each no-login task, destroyed after cleanup.

### Behavior

- **fast** — minimum necessary waiting for deterministic, data-heavy work;
- **human** — bounded mouse, typing, scrolling, and reading cadence;
- **adaptive** — starts fast and temporarily becomes cautious or human-paced after dynamic-page signals, occlusion, timeout, uncertain navigation, action failure, or rate limiting.

Human pacing is a reliability policy, not a promise to bypass website controls or protect an account from platform enforcement.

## Build specialized production workers

Keep site and business logic outside the core:

```bash
node scripts/taskmaster.mjs task-packs scaffold ./my-pack --name my-pack --json
node scripts/taskmaster.mjs task-packs validate ./my-pack --json
node scripts/taskmaster.mjs task-packs install ./my-pack --json
```

A Task Pack defines reusable task types. A specialized Skill teaches the Agent when to use them, how to interpret results, and which platform rules apply. Neither should rebuild Manager startup, browser lifecycle, task tracking, diagnostics, or cleanup.

## Host integration

| Host | Automatic local MCP registration |
| --- | --- |
| Codex, Claude Desktop, Claude Code, Hermes | supported |
| WorkBuddy, DeepSeek Harness, Pi, OpenClaw | adapter required; current release does not modify them automatically |

The browser runtime remains usable through its fixed CLI even when a host-specific MCP adapter is not yet available.

## Verification and shutdown

Run the complete local gate:

```bash
npm run check
```

It covers static boundaries, unit/integration/security tests, real Chromium acceptance, and concurrent/fault/restart workloads. GitHub CI verifies Windows, macOS, and Linux on Node.js 20 and 22. Releases are manually authorized, checksum-protected, and immutable.

Stop the Manager safely:

```bash
node scripts/taskmaster.mjs manager stop --json
```

Start with [`skills/eric-task-master/SKILL.md`](./skills/eric-task-master/SKILL.md). Technical details live in [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`docs/MCP.md`](./docs/MCP.md), and [`docs/RELEASE-GATE.md`](./docs/RELEASE-GATE.md).
