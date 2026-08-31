# Agent rules

Read `ARCHITECTURE.md` before changing code.

- Keep browser execution pure Playwright. Do not add CDP, Puppeteer, Chrome debugger, or a second browser-control plane.
- Keep Profile and task management in the same-origin Web Dashboard. User-installed extensions may run only in persistent Profiles when the Owner enables them. The sole action-coordination surface is the bounded cooperative Worker FIFO; it is not extension authentication. Do not add extension installation/inventory payloads, a second extension control plane, session transfer, or extension-state copying.
- Keep site-specific behavior in task modules or specialized Skills.
- Preserve Profile exclusive leases, task heartbeat/progress, diagnostic screenshots, and deterministic cleanup.
- Never expose cookies, tokens, authentication headers, or profile paths in public API responses or logs.
- Increment the version for every delivered iteration with `npm run version:bump -- patch|minor|major`.
- Run `npm run check` before delivery. This gate includes static boundaries, all tests with real Chromium, and the full acceptance suite.
