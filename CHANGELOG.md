# Changelog

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
