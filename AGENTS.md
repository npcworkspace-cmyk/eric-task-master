# Repository instructions

Keep Eric Task Master on one path:

> Receive the task, write the smallest free `.mjs`, run one CLI command, stream results.

## Scope

- Agent integration is CLI only.
- Use stable local Chrome with Task Master-owned persistent Profiles.
- Manager owns process lifetime, Profile leases, progress, output metadata, stop, resume, and delete.
- Task scripts own browser actions, selectors, waits, retries, checkpoints, HTTP, CDP, and data processing.
- Do not add MCP, Task Type registration, Task Pack assets, mandatory preflight probes, behavior modes, or Journey facades.
- A task may enter `wait({ reason: 'verification' })`: runtime keeps Chrome alive, requests a desktop notification immediately and every 30 seconds, and takes screenshots at 5/10/15/20 minutes. At 20 minutes it automatically pauses, stops reminders, and requires manual resume; the final screenshot is diagnostic only. The Agent judges earlier images; runtime never decides a page is cleared by itself.

## Engineering

- Prefer the smallest implementation that proves the requested outcome.
- Keep Dashboard limited to Tasks and Profiles.
- Any new required pre-run step needs explicit product justification.
- Add a regression test for every bug fix.
- Run `npm run check` before commit.
- Use SemVer; the public “3.00” release is `3.0.0`.
