# eric-task-master architecture

## Invariants

1. Browser work is executed only through Playwright APIs.
2. The everyday-browser extension is control-plane only. Its sole page-data capability is a user-clicked, origin-scoped session transfer.
3. A persistent profile has at most one live lease.
4. Every task has a state, heartbeat, progress record, output directory, and deterministic cleanup.
5. Unknown action outcomes are inspected before retrying.
6. Authentication material never appears in agent-visible responses or logs.
7. Core runtime remains site-agnostic; specialized Skills provide site behavior.

## Components

- `src/manager.mjs`: loopback HTTP manager and API.
- `src/runtime/task-worker.mjs`: isolated Playwright task process.
- `src/runtime/import-session-worker.mjs`: memory-to-profile session importer.
- `src/cli.mjs`: fixed Agent entrypoint.
- `dashboard/`: full management interface served by the manager.
- `extension/`: thin Chromium control panel and explicit session bridge.
- `skills/eric-task-master/`: progressive-disclosure Agent instructions.

## Manager API v1

All responses are JSON. Authenticated routes require `Authorization: Bearer <manager token>`. Extension routes use a paired extension token. Loopback is the only supported bind address.

### Health and pairing

- `GET /v1/health`
- `POST /v1/pair/extension`

### Profiles

- `GET /v1/profiles`
- `POST /v1/profiles`
- `PATCH /v1/profiles/:id`
- `DELETE /v1/profiles/:id`
- `POST /v1/profiles/:id/open`
- `POST /v1/profiles/:id/close`
- `POST /v1/profiles/:id/session`

### Tasks

- `GET /v1/tasks`
- `POST /v1/tasks`
- `GET /v1/tasks/:id`
- `POST /v1/tasks/:id/cancel`

### Dashboard

- `GET /dashboard`
- `GET /dashboard/*`

## Profile states

`idle -> starting -> open -> idle`

An active task changes the state to `leased`. A stale process lock is recovered only after the recorded process is proven absent.

## Task states

`queued -> acquiring_profile -> starting_browser -> running -> verifying -> completed`

Side states are `waiting_user`, `cooling_down`, `recovering`, `failed`, and `cancelled`. Terminal tasks always pass through cleanup.

## Behavior policies

- `fast`: deterministic native Playwright operations with minimum necessary waits.
- `human`: bounded mouse, typing, hover, scroll, and reading delays.
- `adaptive`: starts fast and slows after dynamic-page failures or rate-limit signals.

Task-level policy overrides the profile default and is discarded during cleanup.

## Task module contract

A task module exports `run(runtime)` and may export `meta`.

```js
export const meta = { name: 'example', version: 1 };

export async function run({ page, context, input, outputDir, action, progress, checkpoint }) {
  await page.goto(input.url);
  await progress({ current: 1, total: 1, message: 'Loaded target' });
  return { summary: 'Done', evidence: [{ kind: 'url', value: page.url() }] };
}
```

Returned business data is not streamed implicitly. Modules persist large results under `outputDir` and return a compact summary plus evidence.
