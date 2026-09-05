# Changelog

## 3.1.0 - 2026-09-05

- Send a desktop notification immediately when verification stops work, then every 30 seconds until actual resume, explicit stop/delete, completion, or automatic pause at 20 minutes. Notification failures never gate task control.
- Preserve Chrome, Worker, Profile and checkpoint on automatic pause; require manual resume after the deadline and retain the final screenshot for diagnosis only.
- Bound startup cancellation and resume acknowledgement, reject obsolete probes, and handle tasks that complete immediately after resuming without false failures.
- Contain background Profile cleanup failures with bounded retries, recover after transient state-write failures, bound stalled IPC sends, and reuse confirmed cleanup within one lease.
- Terminate detached descendant process groups during POSIX forced cleanup using bounded ownership snapshots; retain the lease when browser inactivity cannot be confirmed.
- Coalesce frequent progress writes, avoid global task-history rewrites for heartbeats, and share recent output-budget scans on progress.
- Add optional submission request keys and bounded follow calls; drain retained terminal events before returning the final cursor.
- Reuse API-compatible Managers without automatic replacement on normal commands; guard explicit idle maintenance against concurrent task/Profile creation.
- Add clock-driven notification, real Windows notification submission, real Chrome verification, lifecycle, and control-race regressions.
- Run one CI/CodeQL gate per pull-request update and a separate exact-main push gate for publication, avoiding duplicate feature-push checks without removing any required platform or release verification.

## 3.0.3 - 2026-09-04

- Added a three-category Dashboard space cleaner: preview before deletion, preserve login/extension data, skip active Profiles/tasks, and require opt-in for historical task output.
- Opened manual Profile windows with native stable Chrome, without a Playwright or CDP connection; automated tasks reuse the same Profile after the manual window closes.
- Added verification waits with live browser/Worker heartbeats, four five-minute screenshot probes, and Agent-reviewed or manual resume.
- Paused execution timeout accounting during verification waits and rejected stale screenshot resume references.
- Returned screenshot attention and a continuation cursor from CLI follow without ending the task.

## 3.0.2 - 2026-09-04

- Enabled Chrome sandboxing for manual Profile windows and automated tasks while retaining extension support and raw Playwright/CDP access.
- Added launch-configuration and real-browser regression checks to prevent silent unsandboxed startup.
- Added installer-free portable ZIPs for every supported OS/CPU, with bundled-runtime startup and cleanup acceptance on each native CI target.

## 3.0.1 - 2026-09-04

- Fixed early Manager and Profile Worker exits being reported as unhandled promise rejections.
- Aligned manual Chrome startup timeouts, maintained startup heartbeats, and preserved bounded underlying failure details.
- Added Profile renaming to the bilingual Dashboard.
- Resolved release tags explicitly and added read-only verification of immutable published assets.

## 3.0.0 - 2026-09-03

Eric Task Master 3.0 is a clean CLI-first runtime.

- Replaced registered Task Types and Task Pack assets with direct disposable `.mjs` execution.
- Removed MCP, host registration, exact adapter version coupling, mandatory surface probes, Journey/Human behavior, special verification handoff, and completion gating.
- Unified Profiles as persistent stable-Chrome directories with one configurable default.
- Added heartbeat-based stale lease recovery and atomic stop/delete.
- Added streaming progress, partial outputs, generic wait/resume, and direct Playwright/CDP access.
- Rebuilt the Dashboard around Tasks and Profiles only.
- Added self-contained Manager bundles for Windows, macOS, and Linux.

For 2.x history, see Git tags through `v2.9.2`.
