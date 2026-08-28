# Eric Task Master

[English](./README.md) | [简体中文](./README.zh-CN.md)

**A durable browser automation task system for AI agents.**

Version: **2.5.3**

AI agents can reason, plan, and write code, but browser execution is often their weakest link. Built-in agent browsers are convenient for short sessions yet commonly lose login state, task continuity, and recovery context. Thin CDP controllers offer fast low-level access, but leave every Agent to rebuild orchestration, progress tracking, cleanup, and error recovery for each job.

Eric Task Master fills that gap. It is a Playwright-first browser automation runtime that turns web work into durable, isolated, observable jobs. An Agent can start a task, leave it running for hours, reconnect later, inspect evidence, recover from a checkpoint, and verify that the browser closed—without occupying the user's everyday browser or repeatedly spending tokens rediscovering the same execution mechanics.

`AI agent` · `browser automation` · `Playwright` · `MCP server` · `web automation` · `computer use` · `workflow automation` · `browser agent` · `headless browser` · `multi-agent automation`

## What can an Agent build with it?

Task Master is a general execution base, not a site-specific bot. Combined with an Agent, a specialized Skill, or a Task Pack, it can support:

- unattended research, monitoring, and source-backed web collection;
- long-running batch work across hundreds of pages without keeping an Agent turn open;
- authenticated back-office, portal, CMS, CRM, and account workflows through isolated persistent Profiles;
- clean no-login jobs through disposable ephemeral Profiles;
- parallel trusted-local Agents sharing a managed Profile catalog while different live Profiles run independently; same-Profile work queues safely and task records stay attributable;
- recurring operational workflows invoked by an Agent, scheduler, or business system;
- browser QA, content verification, form processing, file upload/download, and evidence capture;
- production Task Packs for lead operations, ecommerce operations, media research, supplier research, customer support, compliance checks, or internal RPA.

Those are composable possibilities, not bundled permissions or claims that every website is supported. Task Master supplies the reliable browser runtime; a specialized Skill or Task Pack supplies the business logic, site policy, parsing, checkpoints, outputs, and completion evidence.

## Why not just use an Agent browser or a CDP script?

| Approach | Good at | What is usually missing |
| --- | --- | --- |
| Built-in Agent browser | quick interactive browsing | durable jobs, reusable login Profiles, long-task recovery, scoped trusted-local Agent operation, explicit cleanup proof |
| One-off CDP controller | fast raw browser control | a stable lifecycle, queues, progress, checkpoints, evidence, resumability, reusable task contracts |
| Eric Task Master | production-shaped browser work | site-specific knowledge, intentionally supplied by Skills and Task Packs |

Task Master does not replace Agent reasoning. It gives that reasoning a dependable pair of browser hands.

## The three-layer model

1. **Task Master runtime** — pure Playwright execution, persistent and ephemeral Profiles, queues, durable tasks, progress, recovery, evidence, cleanup, and a central Human Journey engine for visible browser interaction.
2. **Owner Console** — one fixed local web address does only shared Profile management, task progress, pause, resume, cancel, and safe record deletion. Users sign in directly inside isolated persistent Playwright Profiles.
3. **MCP + Skills + Task Packs** — Agents receive a compact, high-level task interface while reusable domain capabilities stay independent from the core runtime.

This separation keeps the base universal: improve one execution engine, then define many specialized automation workers above it.

## For AI Agents: one fixed bootstrap protocol

If a user gives you this GitHub URL, follow the steps below in order. Do not invent another daemon, port, browser launcher, controller, or retry loop.

> The full repository is the runtime source of truth. On a GitHub Release, `eric-task-master-vX.Y.Z.zip` is the complete runnable project; `eric-task-master-skill-vX.Y.Z.zip` is only the optional Agent instruction adapter and cannot run by itself. `SHA256SUMS` verifies both archives. Clone the matching tag or download the complete project archive—do not substitute the Skill-only archive for the runtime.

1. Authenticate to GitHub if the repository is private, then clone the complete repository.
2. Require Node.js 20 or newer.
3. Read `skills/eric-task-master/SKILL.md`. Install that folder into the host's Skill directory when the host supports Skills; otherwise follow it in place.
4. From the repository root run exactly:

   ```bash
   node scripts/taskmaster.mjs connect --json
   ```

5. `connect` installs the lockfile-pinned runtime and matching Playwright Chromium, safely migrates an idle older Manager, starts the loopback Manager, runs real-browser acceptance, and registers supported local MCP hosts. If an older Manager still has work, migration stops without interrupting it. If `manager.agentHostReloadRequired` is true, reload this Agent host once before MCP verification; the upgraded Manager should remain running.
6. Follow the returned `nextAction`. After correcting the named precondition, retry the same command at most once; do not branch into a speculative replacement controller.
7. Open the returned Owner Console link once. It silently establishes a persistent local session; there is no code to type or Agent-binding flow. Bookmark `http://127.0.0.1:19946/dashboard` for later use.
8. MCP is the default Agent path. For any `registered_pending_*` result, complete the named one-time approval or reload, then verify the live host with `taskmaster_status` and `taskmaster_profiles_list`.
9. Choose one operation path and keep it for the task:
   - if the host loaded the registered MCP server, call `taskmaster_status`, then `taskmaster_profiles_list`;
   - only for `adapter_pending`, `extension_required`, or a host that cannot reload during this run, use the fixed CLI fallback from the repository root. Keep one stable, distinct Agent ID on every scoped command:

     ```bash
     node scripts/taskmaster.mjs status --agent-id STABLE_ID --agent-name AGENT_NAME --json
     node scripts/taskmaster.mjs profiles list --agent-id STABLE_ID --agent-name AGENT_NAME --json
     ```

10. When status and Profile discovery succeed, ask the user what browser task to run. Do not mix MCP and CLI identities during one task.

Copyable request for a new Agent:

> Install and start `https://github.com/npcworkspace-cmyk/eric-task-master`. Clone the full repository, read or install `skills/eric-task-master`, and run only `node scripts/taskmaster.mjs connect --json`. Do not invent another controller or port. Use MCP by default; use the Skill's stable-identity CLI fallback only for `adapter_pending`, `extension_required`, or a host that cannot reload this run. Return the Owner Console link; after live status and Profile discovery succeed, ask what task I want to run.

## Everyday use

After the first bootstrap, the user should be able to ask naturally:

> Use Eric Task Master with an ephemeral Profile and auto behavior to research these sites, report progress, save evidence, and close every task window when finished.

The Agent then uses one durable loop: discover a task type, start once with an idempotency key, retain the task ID, wait or reconnect to that ID, inspect diagnostics when attention is required, and accept completion only after evidence and cleanup are verified.

Every task start returns a clickable Owner Console link focused on that task. The first link silently establishes the local Owner cookie; later visits can use the fixed bookmarked address. If the user says “启动任务面板”, use MCP `taskmaster_dashboard_open` or CLI `node scripts/taskmaster.mjs dashboard-open [TASK_ID] --agent-id STABLE_ID --agent-name AGENT_NAME --json`, then return the link. Task Master does not automatically open an operating-system browser.

### Profiles

- **persistent** — isolated reusable state for logged-in and recurring work; open it from the Dashboard and sign in directly in its Playwright window;
- **ephemeral / 隐身临时** — a clean non-persistent browser for each no-login task, destroyed after cleanup.

New persistent Profiles default to the local stable Chrome channel and `human`; new ephemeral Profiles default to the project-pinned Chromium and `auto`. Every Profile can select `fast`, `auto`, or `human`. A change is acknowledged by the live task Worker and takes effect at its next scheduling or movement boundary without restarting the task. The engine is immutable and never falls back automatically. Manual persistent-Profile windows are always visible; `headless` affects task runs only.

### Behavior

- **fast** — the complete visible action path with compressed timing, while keeping smooth motion and a non-zero per-key cadence for deterministic or data-heavy work;
- **human** — the same complete action path at natural, purpose-aware pacing;
- **auto** — balances speed and caution, escalating after dynamic-page signals, occlusion, timeout, uncertain navigation, action failure, or rate limiting, then accelerating again after recovery.

Human pacing is a reliability policy, not fingerprint spoofing, a promise to bypass website controls, or protection from platform enforcement.
All three modes use smooth minimum-jerk pointer acceleration, one continuous long-distance approach plus precision acquisition, in-target clicks, explicit per-character keyboard events, fine-grained inertial wheel motion, and an optional rapid page survey that normally completes as one continuous downward stream plus one return stream. Fine wheel events are motion frames, not separately paused actions; even `human` keeps long traversal fast. A mode changes central timing and guard depth only; `fast` never becomes paste or jump scrolling. Behavior is selected on the Profile and can be changed while its task runs; task start does not accept an override. Task cards show the actual Worker-confirmed configured/effective mode and receipt time instead of merely echoing the Profile value. Every versioned Task Pack additionally enforces visible-transition verification through the stricter `full-human-v1` journey contract and records its 10/10 interaction audit.

### Multi-Agent workbench

- Profiles are shared by all trusted local Agents; there is no meaningless “Profile creator” field. A Profile still has one live lease, so two Agents cannot corrupt the same login state.
- The Console has only two work areas: Tasks and Profiles. It does not expose a confusing Agent registry, reports, files, or a second messaging workbench.
- Every task gets a stable `Agent-specific task-created time` name and shows its current action, Worker-confirmed runtime behavior, visual progress, execution time, cumulative cooldown time, and total time.
- Pause, resume, cancel, and record deletion are revision-checked. Deletion hides only terminal records with confirmed cleanup and never makes an executed action replayable.

## Build specialized production workers

Keep site and business logic outside the core:

```bash
node scripts/taskmaster.mjs task-packs scaffold ./my-pack --name my-pack --recipe paginated-list --json
node scripts/taskmaster.mjs task-packs validate ./my-pack --json
node scripts/taskmaster.mjs task-packs install ./my-pack --json
```

A Task Pack defines reusable task types. It specifies the target, sequence, selectors, platform rate limits, extraction, checkpoints, outputs, and proof—not custom mouse or scrolling code. The central Human Journey engine handles rendered-page state changes, while read-only Playwright locators and `evaluate` remain a fast, unpaced path for bulk DOM extraction. Reading values and attributes is allowed; mutation hidden in `evaluate` is rejected. Five production scaffolds—single page, paginated list, list/detail, resumable batch, and form workflow—remove most boilerplate, while preflight validates modules before registration. When no specialized capability covers a large request, the built-in read-only `surface-probe` first samples one representative surface, performs a bounded survey/backtrack, identifies blockers, and recommends a recipe; one bounded pilot must pass before scale. A specialized Skill teaches the Agent when to use the resulting type, how to interpret results, and which platform rules apply.

## Host integration

| Host | Automatic local MCP registration |
| --- | --- |
| Codex | automatic registration; live tool discovery and Task Master calls verified locally |
| WorkBuddy Desktop | automatic registration; live host-launched bridge verified, with a host reload required after runtime upgrades |
| Hermes | automatic registration; live discovery of 21 tools plus `taskmaster_status` and `taskmaster_profiles_list` calls verified locally |
| Claude Desktop, Claude Code | automatic registration; activation still requires that host to load the entry and complete a live tool call |
| CodeBuddy CLI, Gemini CLI | automatic registration adapter; real-host matrix pending |
| OpenClaw | official-CLI registration adapter; real-host matrix pending |
| DeepSeek Harness, VS Code/Copilot, OpenCode | MCP capable; safe automatic adapter pending |
| Pi | MCP extension required by the host's design |

Each Agent host starts its own STDIO MCP bridge, while all bridges reuse one Manager, Profile catalog, scheduler, and durable task runtime. The scoped CLI remains only an emergency compatibility path. Every independent CLI Agent keeps one stable, distinct `--agent-id`; reusing one ID intentionally shares that principal's task history and Owner-command inbox. See [`docs/MCP-HOSTS.md`](./docs/MCP-HOSTS.md) for the host matrix and trusted-local boundary.

The release gate uses four independent real STDIO MCP protocol clients carrying Codex, WorkBuddy, and Hermes identities against one isolated Manager. It verifies shared Profiles, per-Agent task and artifact isolation, same-Profile FIFO, cross-Profile parallelism, and task survival across an Agent reconnect. Real host loading and tool calls are validated separately on installed hosts.

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

## License

[MIT](./LICENSE). Use, modify, distribute, and build open or proprietary Skills and Task Packs on top of Task Master.
