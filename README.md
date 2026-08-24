# Eric Task Master

Eric Task Master is a Playwright browser task runtime for AI Agents. It turns browser work into durable, isolated jobs instead of asking an Agent to repeatedly inspect pages and improvise a new controller.

Version: **1.0.0**

## What it does

- Runs clicks, input, navigation, uploads, downloads, reading, screenshots, and data extraction through pure Playwright.
- Keeps logged-in work in isolated persistent Profiles; runs no-login work in disposable **ephemeral (隐身临时)** Profiles that retain no browser state after a task.
- Lets multiple Agents use different Profiles concurrently. Work aimed at the same Profile enters a bounded FIFO queue instead of stealing tabs or failing randomly.
- Gives every task a durable ID, live progress, heartbeat, checkpoint, evidence, artifacts, cancellation, recovery, completion verification, and automatic browser cleanup.
- Uses `adaptive` behavior to stay fast during deterministic work, add light settling on dynamic pages, and temporarily switch to guarded human pacing after occlusion, timeout, uncertain navigation, or rate limiting. It never blindly retries an action with an unknown outcome.
- Captures both a screenshot and a bounded semantic page observation when an action fails, a task times out, progress stalls, or a workflow asks the user/Agent for a new instruction.
- Discovers task capabilities progressively: Agents first receive compact summaries, then read only the selected task's input contract.
- Installs reusable **Task Packs** transactionally, so specialized Skills can add site or workflow knowledge without modifying the browser runtime.

This enables unattended daily work, batch research and collection, repeated operations, long-running browser jobs, and multi-Agent browser execution while reducing repeated page-reading and controller-generation tokens. The exact savings depend on the workflow; this project does not claim a universal percentage.

## Three layers

1. **Task Master runtime** — Profiles, Playwright execution, queues, health, checkpoints, evidence, recovery, and cleanup.
2. **Real-browser control panel** — Profile settings and an explicit current-site session transfer. The extension never becomes the automation engine.
3. **MCP + Skills + Task Packs** — small Agent tools and reusable workflow-specific behavior.

Core stays site-agnostic. Reddit, ecommerce, creator discovery, form workflows, pagination, parsing, and platform-specific rate-limit rules belong in specialized Skills or Task Packs.

## One fixed start

Requires Node.js 20 or newer. From the project root run:

```bash
node scripts/taskmaster.mjs connect --json
```

That command installs lockfile-pinned dependencies and Playwright Chromium when missing, starts the loopback Manager, runs the real-browser acceptance suite, and registers the same STDIO MCP server in detected supported Agent hosts. If a host reports `registered_pending_restart`, reload that host once.

Load [`extension/`](./extension/) as an unpacked Chromium extension and enter the returned `ETM1...` pairing code. The extension verifies the Manager's pinned Ed25519 identity before sending any local credential or session data.

After MCP discovery, an Agent follows one loop:

1. Check status and list Profiles.
2. Search compact task-type summaries and describe only the selected type.
3. Start once with an idempotency key and retain the task ID.
4. Wait on that ID. Never create a duplicate because an Agent disconnected.
5. If the task reports `waiting_user` or `stalled`, read its diagnostic artifacts before continuing or resuming.
6. Accept completion only after cleanup is settled and evidence/artifacts prove the result.

## Profile choice

- **persistent** — for login state and recurring account work. One live task uses the Profile at a time.
- **ephemeral / 隐身临时** — for no-login tasks. Every task receives a fresh non-persistent context and the browser is destroyed at cleanup. “隐身” means disposable local state; it is not an anti-fingerprinting or restriction-bypass claim.

## Build specialized capability

Create a reusable Task Pack without editing core:

```bash
node scripts/taskmaster.mjs task-packs scaffold ./my-pack --name my-pack --json
node scripts/taskmaster.mjs task-packs validate ./my-pack --json
node scripts/taskmaster.mjs task-packs install ./my-pack --json
```

A specialized Skill should teach discovery, platform logic, checkpoints, outputs, and completion evidence, then call the registered Task Master task types. It should not recreate Manager, browser launch, Profile, progress, diagnostics, or cleanup code.

## Verification

```bash
npm run check
```

The delivery gate runs static boundaries, unit/integration/security tests, real Chromium feature acceptance, and a concurrent/fault/restart commercial acceptance workload. Cross-platform CI is defined for Windows, macOS, and Linux; a platform is considered verified only when its own CI run passes.

Start with [`skills/eric-task-master/SKILL.md`](./skills/eric-task-master/SKILL.md). Runtime details are in [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`docs/MCP.md`](./docs/MCP.md), and [`docs/RELEASE-GATE.md`](./docs/RELEASE-GATE.md).

Stop the local Manager safely with:

```bash
node scripts/taskmaster.mjs manager stop --json
```
