---
name: eric-task-master
description: Connect to eric-task-master, select an isolated persistent Playwright profile, and run monitored browser tasks. Use for browser work that needs reusable login state, parallel Agent isolation, progress, recovery, or specialized task modules.
---

# eric-task-master

Use Task Master as the browser execution layer. Playwright performs every browser action; the everyday-browser extension is only a profile, consent, and status panel.

## Fixed startup

Run the same command from either the cloned project root or this Skill directory. Both locations expose `scripts/taskmaster.mjs`; do not search for another launcher.

An install or first use is incomplete until this command succeeds:

```bash
node scripts/taskmaster.mjs connect --json
```

`connect` installs the lockfile-pinned dependencies and Playwright Chromium when missing, starts the local manager if necessary, and runs the full built-in acceptance suite. Do not invent alternate ports, browser flags, controller scripts, or connection paths. If it fails, retry the same command once. Then report its `error` and `nextAction` without speculative rewrites.

After a successful connection, list profiles:

```bash
node scripts/taskmaster.mjs profiles list --json
```

Create one only when no suitable profile exists. A profile is exclusively leased while a task or manual window uses it; concurrent Agents must select different profiles.

## Run work

Use a specialized Skill when one matches the site or workflow. Otherwise create a small task module from the contract in [references/task-runtime.md](references/task-runtime.md), then submit it through the fixed launcher. Keep site selectors, pagination, parsing, and business rules in that module, never in the base Skill.

Follow every non-trivial task until terminal state. The runtime emits progress and heartbeats, captures diagnostics on silence or failure, checkpoints work, and closes task windows in cleanup. Do not submit a duplicate when a task appears lost; query or follow the existing task ID.

For authenticated work, read [references/profiles-and-sessions.md](references/profiles-and-sessions.md). Never request, print, save, or return cookies, tokens, authentication headers, or browser profile files. The user authorizes a site-scoped transfer from the extension panel.

## Completion

Claim completion only from the task's terminal response and evidence. Large results belong in the task output directory; module return values are compact summaries, not an implicit data stream.
