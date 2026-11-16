# Repository instructions

Keep Eric Task Master on one path:

> Receive the task, write the smallest free `.mjs`, run one CLI command, stream results.

## Scope

- Agent integration is CLI only.
- All scripts and operations use stable local Chrome with Task Master-owned persistent Profiles. Reuse the selected or saved default Profile; a task/session may span many tabs. Personal Agent routing between Task Master and another browser tool belongs outside this product.
- Manager owns process lifetime, Profile leases, progress, output metadata, stop, resume, and delete.
- Task scripts own browser actions, selectors, waits, retries, checkpoints, HTTP, CDP, and data processing.
- Do not add MCP, Task Type registration, Task Pack assets, mandatory preflight probes, or Journey facades. User-approved execution modes are batch and operations; auto is selection policy. Prompt-explicit mode overrides Profile default only for that task, followed by Skill recommendation/intent and legacy batch default. Human takeover is a separate pause lock, never an execution mode; it cannot be automatically reversed. Mode changes never change identity or authorization.
- The bounded operations service is an explicit exception to one-script execution: Manager persists permission/action/event records and schedules; the existing worker holds browser context and runs bounded commands. Every external effect requires a durable initiated ACK, readback verification, and uncertain-result reconciliation before any replay.
- General operations have the same Profile access as batch scripts. Website identity selectors and narrow action/resource allowlists are optional explicit guards, not mandatory setup. Keep ordinary observation, navigation and non-effect recovery available. A browser action receipt is not proof of business delivery; the Agent verifies the actual outcome. Retain unknown-effect replay protection, revocation, stop and manual takeover.
- Use one documented JSON CLI contract for every Agent. Keep host differences at the invocation/wait boundary; no model-specific browser permissions. Return useful next observations with action replies and wait locally without empty model-facing polling.
- A task may enter `wait({ reason: 'verification' })`: runtime keeps Chrome alive, requests a desktop notification immediately and every 30 seconds, and takes screenshots at 5/10/15/20 minutes. At 20 minutes it automatically pauses, stops reminders, and requires manual resume; the final screenshot is diagnostic only. The Agent judges earlier images; runtime never decides a page is cleared by itself.

## Engineering

- Prefer the smallest implementation that proves the requested outcome.
- Keep Dashboard limited to Tasks and Profiles.
- Show only current tasks in Dashboard; terminal task cards disappear without deleting records or output needed by CLI follow.
- Any new required pre-run step needs explicit product justification.
- Add a regression test for every bug fix.
- Run `npm run check` before commit.
- Use SemVer; the public “3.00” release is `3.0.0`.
