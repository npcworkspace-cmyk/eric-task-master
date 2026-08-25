# Changelog

## 1.0.3 - 2026-08-25

- Replaced automatic post-CI publication with an explicitly authorized manual Release that accepts an exact `main` SHA and confirmed version.
- Added candidate-branch CI for `upgrade/**` Playwright migrations without allowing candidates or pull requests to publish.
- Required a successful same-SHA `main` push CI, the current `main` head, administrator confirmation plus post-publication verification of GitHub Release immutability, and a previously unused tag/version.
- Removed Release asset replacement; new archives are attached to a draft and published once after all assets are present.

## 1.0.2 - 2026-08-24

- Made the full Windows, macOS, and Linux gate deterministic across Node.js 20 and 22 by removing cleanup-state timing assumptions and using portable extension and registration fixtures.
- Made manually opened Profile windows honor their configured headless mode, including Linux environments without a display server.
- Preserved a safe diagnostic-observation artifact when semantic inspection is transiently unavailable, so screenshot fallback never silently loses the reason or observation status.
- Upgraded CI to the current official Node 24-based GitHub Actions releases.
- Added gated CD: only a successful same-repository `main` push can publish exact-commit source, extension, and Skill archives with SHA-256 checksums as an immutable GitHub Release.

## 1.0.1 - 2026-08-24

- Hardened Manager shutdown, cleanup receipts, terminal-state handling, diagnostic screenshot delivery, session-import deadlines, public output budgets, and principal isolation after adversarial review.
- Expanded MCP image delivery, task durability, profile-worker, shutdown-proof, and real-browser acceptance coverage.
- Corrected the release version without rewriting the existing `1.0.0` release history.

## 1.0.0 - 2026-08-24

- Added task-scoped ephemeral Profiles for login-free work. Each run starts from a fresh isolated browser context, blocks service workers, persists no cookies or site storage, and closes automatically.
- Reworked `adaptive` behavior into visible fast, cautious, guarded, and cooldown states so ordinary work stays fast while ambiguity, failure, or rate limits trigger bounded protection without blind action replay.
- Added progressive task discovery, full contract-on-demand, transactional versioned Task Packs, and a portable scaffold for specialized Skills without adding site logic to the core.
- Added bounded semantic page observations, stable element references, cross-origin frame discovery, and automatic screenshot plus semantic evidence for timeouts, failures, stalls, and human handoffs.
- Added same-task `waiting_user` continuation so an Agent or user can inspect the live page and resume the existing Worker without restarting or duplicating uncertain actions.
- Added bounded FIFO scheduling across Profiles, same-Profile lease serialization, queue visibility, task cancellation, explicit cooldown countdowns, separate heartbeat/progress health, stall diagnosis, and fail-closed recovery.
- Expanded the extension and Dashboard to manage persistent and ephemeral Profiles, observe effective behavior, queues, cooldowns, stalled tasks, diagnostics, and continuation requests.
- Added a commercial acceptance gate covering real Chromium actions, session handling, ephemeral-state erasure, semantic observation, handoff, concurrent Profiles, queue pressure, cancellation, failure diagnostics, cleanup, and Manager restart persistence.
- Added Windows, macOS, and Linux CI across Node.js 20 and 22, plus a concise fixed-path base Skill and machine-safe MCP contracts for new Agents.

## 0.0.3 - 2026-08-24

- Upgraded `human` behavior with bounded curved pointer paths, safe in-target click positions, realistic press duration, per-character typing rhythm, punctuation pauses, eased scrolling, and explicit bounded reading dwell.
- Kept `fast` free of artificial delays and `adaptive` fast until a dynamic-page, failure, or rate-limit signal requests temporary human pacing.
- Added deterministic behavior tests and real Chromium event-trace acceptance for pointer, input, wheel, and reading mechanics.

## 0.0.2 - 2026-08-24

- Added a standard STDIO MCP server with scoped per-host Agent identities and durable task tools.
- Added transactional multi-host MCP registration, ownership, rollback, conflict detection, and relocation support.
- Replaced raw task module submission with verified task-type snapshots and persistent idempotency.
- Added declared, owner-scoped, bounded artifacts and removed local output paths from public responses.
- Added Manager auto-start from MCP, concurrent cold-start protection, and safe staging for disposable single-file task modules.
- Hardened extension pairing and Dashboard authorization with one-time approval codes and scoped expiring sessions.
- Expanded real Chromium acceptance to session transfer, all three behavior modes, upload/download, screenshots, progress, checkpoints, artifacts, and cleanup.
- Carried unresolved browser effects across task attempts and blocked new actions until trusted task logic records a verified observed outcome.
- Removed private CAS staging hardlinks immediately after host-configuration publication.
- Simplified `checkpoint.read()` to return the stored task data directly and documented idempotent output patterns for crash-safe resume.
- Reduced permanent extension host access to the exact loopback Manager origin; website access remains temporary and user-approved.
- Converted Manager task responses to an explicit public-field allowlist so future internal fields fail closed.
- Preserved declared artifact bytes exactly, retained failed browser actions as unknown until observed, recovered dead interrupted-task leases on resume, aligned extension request deadlines with Manager operations, and aborted task actions before timeout diagnostics.
- Added explicit, owner-scoped, idempotent checkpoint resume on the same durable task ID with preserved attempts and history.
- Added a Manager completion gate for result shape, declared artifact stability, browser closure, Worker exit, and Profile lease release.
- Made current-origin session import transactional: replace old destination state, verify it, and restore the exact prior origin snapshot on failure.
- Added per-task output budgets with bounded link-safe accounting and reserved diagnostic screenshot capacity; limits fail closed without deleting task output.
- Added a private metadata-only effect journal so interrupted actions remain inspectable without storing selectors, values, URLs, or credentials.

## 0.0.1 - 2026-08-23

- Created the independent Playwright-first Task Master runtime.
- Added persistent isolated Profiles with exclusive leases and a real-browser management extension.
- Added explicit current-origin Cookie and LocalStorage transfer without plaintext state files.
- Added fast, human, and adaptive task behavior modes.
- Added child-process task isolation, progress, heartbeats, checkpoints, diagnostics, outputs, cancellation, and cleanup.
- Added the local Dashboard, fixed Agent CLI, base Skill, version gate, and real Chromium acceptance suite.
