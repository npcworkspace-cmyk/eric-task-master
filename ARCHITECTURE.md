# eric-task-master architecture

## Invariants

1. Browser work is executed only through Playwright APIs.
2. The everyday-browser extension is control-plane only. Its sole page-data capability is a user-clicked, origin-scoped session transfer.
3. A persistent profile has at most one live lease.
4. Every task has a state, heartbeat, progress record, output directory, and deterministic cleanup.
5. Unknown action outcomes are inspected before retrying.
6. Authentication material never appears in agent-visible responses or logs.
7. Core runtime remains site-agnostic; specialized Skills provide site behavior.
8. Agent hosts receive scoped MCP identities; no host configuration contains Manager, browser, or account credentials.
9. Agent-visible task results contain bounded summaries and declared artifacts, never local execution paths.
10. A persistent Ed25519 Manager identity authenticates the loopback endpoint before any admin, extension, or session credential leaves its owner.

## Components

- `src/manager.mjs`: loopback HTTP manager and API.
- `src/runtime/task-worker.mjs`: isolated Playwright task process.
- `src/runtime/import-session-worker.mjs`: memory-to-profile session importer.
- `src/cli.mjs`: fixed Agent entrypoint.
- `src/mcp/`: standard STDIO MCP server and scoped Manager client.
- `src/registration/`: transactional, per-host MCP configuration adapters.
- `dashboard/`: full management interface served by the manager.
- `extension/`: thin Chromium control panel and explicit session bridge.
- `skills/eric-task-master/`: progressive-disclosure Agent instructions.

## Manager API v1

All responses are JSON. Loopback is the only supported bind address. Manager admin, scoped Agent, extension, and short-lived Dashboard credentials have separate roles.

The first Manager state initialization persists an Ed25519 key pair beside the protected admin credential. `POST /v1/identity/challenge` signs a caller-generated 256-bit nonce together with the exact service, version, API version, host, and listening port. CLI and MCP verify that proof against the public key pinned in local state before sending the Manager admin credential. A port occupant, wrong key, stale signature, or binding mismatch fails closed.

### Health and pairing

- `GET /v1/health`
- `POST /v1/identity/challenge`
- `POST /v1/agents/issue`
- `POST /v1/pair/authorize`
- `GET /v1/pair/challenge`
- `POST /v1/pair/extension`

`connect` returns one `ETM1.<approval>.<fingerprint>` pairing code. The fingerprint is the full SHA-256 digest of the Manager public key. The MV3 popup verifies a fresh signed identity challenge against that fingerprint before sending the pairing code, and stores the resulting public identity pin only in `chrome.storage` trusted contexts. Every later request carrying the extension token re-verifies the pin. Session transfer additionally verifies identity before reading page state, rechecks tab and origin before sending, and revokes its temporary origin permission in `finally`.

### Profiles

- `GET /v1/profiles`
- `POST /v1/profiles`
- `PATCH /v1/profiles/:id`
- `DELETE /v1/profiles/:id`
- `POST /v1/profiles/:id/open`
- `POST /v1/profiles/:id/close`
- `POST /v1/profiles/:id/session`

### Tasks

- `GET /v1/task-types`
- `POST /v1/task-types/install` (Manager admin only)
- `GET /v1/tasks`
- `POST /v1/tasks`
- `GET /v1/tasks/:id`
- `POST /v1/tasks/:id/resume`
- `POST /v1/tasks/:id/cancel`
- `GET /v1/tasks/:id/artifacts`
- `GET /v1/tasks/:id/artifacts/:artifactId`

### Dashboard

- `GET /dashboard`
- `GET /dashboard/*`
- `POST /v1/dashboard/authorize`
- `POST /v1/dashboard/session`

Dashboard URLs never contain the Manager admin credential. A Manager admin or paired extension creates a one-use authorization code; the page exchanges it for an in-memory, expiring Dashboard session.

## Profile states

`idle -> starting -> open -> idle`

An active task changes the state to `leased`. A stale process lock is recovered only after the recorded process is proven absent.

## Task states

`queued -> acquiring_profile -> starting_browser -> running -> verifying -> completed`

Side states are `waiting_user`, `cooling_down`, `recovering`, `failed`, and `cancelled`. Terminal tasks always pass through cleanup.

`completed` is never accepted directly from a Worker. A Worker completion claim first enters `verifying`; Manager then validates the bounded result shape, every declared agent-visible artifact, confirmed browser closure, Worker exit, and Profile lease release. A failed gate becomes `TASK_COMPLETION_GATE_FAILED`.

A failed task with a stable checkpoint can be resumed only by its original owner through an explicit request with a stable `resumeKey`. Resume keeps the same task ID, input, timeout, output directory, checkpoint, and original module snapshot; increments `attempt`; and appends bounded attempt history. The same key is idempotent. A non-failed task, unsettled cleanup, missing/unstable checkpoint, missing persisted context, or changed module hash fails closed. Modules must inspect current site state before repeating any external action whose outcome was unknown.

## Behavior policies

- `fast`: deterministic native Playwright operations with minimum necessary waits.
- `human`: bounded mouse, typing, hover, scroll, and reading delays.
- `adaptive`: starts fast and slows after dynamic-page failures or rate-limit signals.

Task-level policy overrides the profile default and is discarded during cleanup.

Each task output is bounded by a worker-enforced default budget of 512 MiB and 10,000 files. The worker checks it periodically and before progress, checkpoint, and completion; exceeding it fails the task without deleting existing output. A separate small reserve remains available for controlled diagnostic screenshots. The scanner never follows links and has independent entry/depth bounds.

Actions made through the task-scoped facade append an internal metadata-only effect journal (`started`, `succeeded`, or explicitly observed `failed`). Records contain only a sequence, fixed operation name, and timestamp—never selectors, values, URLs, or credentials. A Playwright exception leaves `started` pending because it cannot prove the website did nothing. That outcome must be inspected and must not be replayed blindly.

## Task module contract

A task module is a trusted, bounded single-file `.mjs` that exports `run(runtime)` and may export `meta`. Manager snapshots the source before execution and binds task idempotency to that snapshot hash.

Manager never imports a task module while installing it. A short-lived inspector child loads the snapshot, returns bounded JSON metadata, and is force-stopped on exit, error, or timeout; Manager hashes the snapshot again before registering it. This protects Manager availability from accidental top-level exits or waits, but it is not a sandbox for untrusted code. External installation is idempotent for the same SHA and returns `409 TASK_TYPE_CONFLICT` for a same-name different SHA. Only the internal seed path may explicitly replace a built-in task during an application upgrade.

```js
export const meta = { name: 'example', version: '1.0.0' };

export async function run({ page, context, input, outputDir, action, cooldown, effects, progress, checkpoint, signal }) {
  await action.goto(input.url, { waitUntil: 'domcontentloaded' });
  await progress({ current: 1, total: 1, message: 'Loaded target' });
  return { summary: 'Done', evidence: [{ kind: 'url', value: page.url() }] };
}
```

Each attempt replays the same internal effect journal. State-changing operations must use `action`; direct `page` access is observational. A `started` record without a durable terminal record is carried into the next attempt and blocks every new action until trusted task logic inspects external state and explicitly resolves that exact sequence as observed succeeded or observed not applied. Resume never clears an unknown outcome implicitly. Timeout, cancellation, and output-budget failure abort the task signal before bounded screenshot diagnostics, so the action facade rejects late operations before cleanup.

`checkpoint(data)` persists an internal timestamped envelope, while task code sees only the exact prior `data` from `checkpoint.read()`. Output and checkpoint are not one filesystem transaction; resumable modules therefore use deterministic per-unit outputs or stable-key deduplication instead of blind append-only writes.

Returned business data is not streamed implicitly. Modules persist large results under `outputDir`, declare agent-visible relative artifacts in evidence, and return a compact summary. Public task views expose opaque artifact references instead of local paths. Declared artifact chunks are byte-preserving so structured files and hashes remain valid; declaring a file Agent-visible is therefore an explicit disclosure decision by trusted task code.
