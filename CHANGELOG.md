# Changelog

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
