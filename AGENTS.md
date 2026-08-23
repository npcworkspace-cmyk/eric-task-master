# Agent rules

Read `ARCHITECTURE.md` before changing code.

- Keep browser execution pure Playwright. Do not add CDP, Puppeteer, Chrome debugger, or page automation to the extension.
- Keep the extension control-plane only; session transfer must remain origin-scoped and user-clicked.
- Keep site-specific behavior in task modules or specialized Skills.
- Preserve Profile exclusive leases, task heartbeat/progress, diagnostic screenshots, and deterministic cleanup.
- Never expose cookies, tokens, authentication headers, or profile paths in public API responses or logs.
- Increment the version for every delivered iteration with `npm run version:bump -- patch|minor|major`.
- Run `npm run check` before delivery. This gate includes static boundaries, all tests with real Chromium, and the full acceptance suite.
