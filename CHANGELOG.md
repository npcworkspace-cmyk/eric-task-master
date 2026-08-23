# Changelog

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
