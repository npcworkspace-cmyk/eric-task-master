# Eric Task Master

Eric Task Master is a Playwright-first browser task system for AI Agents. It gives Agents durable browser Profiles, isolated task windows, progress and recovery, optional human-paced behavior, and reusable task Skills without making the everyday browser the automation engine.

Version: **0.0.2**

## What it enables

- Multiple Agents can work in separate persistent browser Profiles without stealing each other's tabs, focus, or login state.
- Short and long browser tasks keep a durable task ID, progress, heartbeat, checkpoint, artifacts, cancellation, and automatic window cleanup.
- `fast`, `human`, and `adaptive` behavior can be selected per Profile or per task; deterministic data work stays fast by default.
- A lightweight Chromium extension manages Playwright Profiles and lets the user explicitly copy the current site's session into a chosen Profile.
- Standard MCP tools let supported Agent hosts discover and use the same Task Master after one registration flow.
- Specialized Skills can add site or workflow logic as verified task types while reusing the same Profile, task, progress, evidence, and cleanup foundation.

The three layers are deliberately separate:

1. **Playwright + Manager** — reliable browser execution, isolation, lifecycle, and outputs.
2. **Real-browser panel** — Profile settings and user-approved current-site session transfer only.
3. **MCP + Skills** — simple Agent tools and reusable workflow-specific task modules.

## One fixed start

Requires Node.js 20 or newer. From the project root run:

```bash
node scripts/taskmaster.mjs connect --json
```

This fixed command installs lockfile-pinned dependencies and Playwright Chromium when missing, starts the local Manager at `http://127.0.0.1:19946`, runs the real-browser acceptance suite, and transactionally registers the STDIO MCP server in detected supported Agent hosts. If a host reports `registered_pending_restart`, reload that host once.

Load [`extension/`](./extension/) as an unpacked extension in a Chromium browser. Enter the single `ETM1...` pairing code returned by `connect`; it includes a SHA-256 Manager identity fingerprint. The extension verifies a fresh signed local challenge before it sends that code or any extension/session credential, and keeps the public identity pin in trusted extension storage. The extension does not click, type, navigate, or scrape web pages for tasks.

After MCP discovery, an Agent follows one small loop:

1. Check `taskmaster_status` and list Profiles.
2. List installed task types.
3. Start a task with an idempotency key and keep its task ID.
4. Wait or reconnect to that same task ID.
5. If it failed with a checkpoint, explicitly resume that same ID with a stable resume key; never submit a duplicate.
6. Read its compact evidence and declared artifacts.

MCP starts Manager automatically on the first tool call if it is not already running. A disconnected wait does not destroy the browser task, and task windows close when cleanup settles.

Worker code cannot declare success by itself. Manager first verifies the result contract, every declared Agent-visible artifact, browser closure, Worker exit, and Profile lease release. Failed checkpointed work keeps its original task ID, input, module snapshot, output, attempt history, and can be resumed explicitly after a Manager restart without blindly replaying an unknown website action.

## Product boundary

- Browser execution is pure Playwright; the extension is a control and consent surface.
- Account state stays in local persistent Profiles. Session transfer is limited to the active site and requires an explicit user click.
- Session transfer verifies the pinned Manager before reading cookies or LocalStorage, rejects tab/origin drift, replaces rather than merges the destination origin, rolls back on failure, and revokes its temporary site permission.
- Core Task Master stays site-agnostic. Selectors, pagination, parsing, rate-limit policy, and business rules belong in specialized Skills or single-file task modules.
- Agent-visible APIs do not return Manager credentials, cookies, Profile directories, module paths, or local output paths.

Agents should start with [`skills/eric-task-master/SKILL.md`](./skills/eric-task-master/SKILL.md). Developers can read [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`docs/MCP.md`](./docs/MCP.md), and [`docs/MCP-HOSTS.md`](./docs/MCP-HOSTS.md).

Run the complete local delivery gate with:

```bash
npm run check
```

Stop the local Manager safely with:

```bash
node scripts/taskmaster.mjs manager stop --json
```
