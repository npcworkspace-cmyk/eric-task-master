# eric-task-master architecture

## Invariants

1. Browser work is executed only through Playwright APIs.
2. The everyday-browser extension is control-plane only. Its sole page-data capability is a user-clicked, origin-scoped session transfer.
3. Every Profile has at most one live lease. A persistent Profile owns browser state; an ephemeral Profile is a clean task-scoped context template and retains none after confirmed cleanup.
4. Every task has a state, heartbeat, progress record, output directory, and fail-closed cleanup proof. An unconfirmed browser close blocks the Profile lease.
5. Unknown action outcomes are inspected before retrying.
6. Authentication material never appears in agent-visible responses or logs.
7. Core runtime remains site-agnostic; specialized Skills provide site behavior.
8. Agent hosts receive scoped MCP identities; no host configuration contains Manager, browser, or account credentials.
9. Agent-visible task results contain bounded summaries and declared artifacts only after completion verification, never local execution paths.
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

`kind` is immutable. Agent-created Profiles are `private` by default and may be changed to `shared` only by their owner or the local control plane. Private Profiles are hidden from and unusable by other scoped Agents. Shared Profile access never grants access to another Agent's task record or artifacts. Legacy Profiles without an access field migrate as shared for compatibility. `persistent` Profiles can be opened and receive explicit origin-scoped session transfer. `ephemeral` Profiles reject both operations and launch `browser.newContext()` inside each task; cleanup closes the context and owning browser.

Agent authorization is scoped to one stable registered MCP client ID and role tuple. Internal Manager, Dashboard, extension, task, Profile, and session principal names/prefixes cannot be issued as Agent IDs. Different host registrations/client IDs are separate principals. Multiple conversations that reuse one host registration intentionally share that principal; deployments needing tenant isolation assign distinct client IDs.

### Tasks

- `GET /v1/task-types`
- `GET /v1/task-types/:id`
- `POST /v1/task-types/install` (Manager admin only)
- `POST /v1/task-packs/install` (Manager admin only, transactional batch)
- `GET /v1/tasks`
- `POST /v1/tasks`
- `GET /v1/tasks/:id`
- `POST /v1/tasks/:id/continue`
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

`idle -> starting -> open -> idle`; an unconfirmed browser close becomes `error` and retains its cleanup-required lease.

An active task changes the state to `leased`. A stale non-browser lock is recovered only after the recorded process is proven absent. Browser-bearing task/Profile leases additionally require a matching private cleanup receipt; Worker PID disappearance alone never proves browser closure.

## Task states

`queued -> acquiring_profile -> starting_browser -> running -> verifying -> completed`

Manager owns a bounded FIFO scheduler. Different Profiles may occupy independent slots; work for the same Profile remains queued until the previous Worker exits and its lease is released. Queue position/reason are public. Manager restart preserves never-started queued tasks and fails interrupted active work closed.

Task and manually opened Profile leases renew through a serialized barrier. Finalization first stops new renewals, drains the in-flight renewal, then releases exactly once. A live session import/manual Profile is treated as busy; a dead owner without cleanup proof blocks queued work instead of being mistaken for ordinary contention.

Side states are `waiting_user`, `cooling_down`, `recovering`, `failed`, and `cancelled`. Terminal tasks always pass through cleanup.

Heartbeat and progress are separate clocks. Heartbeat proves Worker liveness. `progressAt` proves application work advanced. The default stall detector requests screenshot plus semantic diagnostics after two minutes without progress and fails/cleans up after ten minutes of continued silence; explicit `waiting_user` and `cooling_down` states are exempt. Diagnostic capture is best-effort when the Worker or page event loop is itself unresponsive.

`waiting_user` is an in-process handoff, not a new task. The Worker captures diagnostics, publishes one bounded request ID, and waits. Only a matching continuation from the owning Agent/authorized Dashboard resumes the same Worker; timeout or cancellation fails closed and cleanup closes its browser.

`completed` is never accepted directly from a Worker. A Worker completion claim first enters `verifying`; Manager then validates the bounded result shape, every declared agent-visible artifact, confirmed browser closure, Worker exit, and Profile lease release. The verified artifact size and SHA-256 anchors are rechecked on reads and idempotent replays. Until this succeeds, result data and result artifacts remain private; a changed anchor becomes `TASK_COMPLETION_INTEGRITY_FAILED`. A failed initial gate becomes `TASK_COMPLETION_GATE_FAILED`.

A failed task with a stable checkpoint can be resumed only by its original role/client owner through an explicit request with a stable `resumeKey`. Resume keeps the same task ID, input, timeout, output directory, checkpoint, and original module snapshot; increments `attempt`; and appends bounded attempt history. Manager freezes the verified checkpoint into a private attempt-scoped input. The resumed Worker must consume that exact snapshot before any browser action, checkpoint replacement, or unknown-effect resolution. The same key is idempotent. A non-failed task, unsettled cleanup, missing/unstable checkpoint, missing persisted context, or changed module hash fails closed. Modules must inspect current site state before repeating any external action whose outcome was unknown.

## Behavior policies

- `fast`: deterministic native Playwright operations with minimum necessary waits.
- `human`: bounded curved pointer motion, safe in-target click offsets and press duration, per-character typing rhythm, eased scrolling, and explicit reading dwell.
- `adaptive`: starts fast, uses a short cautious tier for ordinary dynamic signals, and uses bounded guarded human pacing after occlusion, timeout, uncertain navigation, action failure, or rate limiting. Stronger signals retain a larger guarded-action budget; successful actions decay back to fast. No tier retries an unknown effect automatically.

Task-level policy overrides the profile default and is discarded during cleanup.
Only task logic knows when content is actually being read, so it requests bounded dwell with `action.read({ words })`; the runtime does not guess from page size or silently slow deterministic collection.

Each task output is bounded by a worker-enforced default budget of 512 MiB and 10,000 files. The worker checks it periodically and before progress, checkpoint, and completion; exceeding it fails the task without deleting existing output. A separate small reserve remains available for controlled diagnostic screenshots. Each automatic diagnostic screenshot is a complete, viewport-wide JPEG capped at 48 KiB, so MCP can return it as one valid image instead of mislabeled image fragments. The scanner never follows links and has independent entry/depth bounds. Checkpoint envelopes have an independent 8 MiB cap and are atomically rejected before replacing the last valid checkpoint; bulk records belong under `outputDir`.

Actions made through the task-scoped facade append an internal metadata-only effect journal (`started`, `succeeded`, or explicitly observed `failed`). Records contain only a sequence, fixed operation name, and timestamp—never selectors, values, URLs, or credentials. A Playwright exception leaves `started` pending because it cannot prove the website did nothing. That outcome must be inspected and must not be replayed blindly.

## Task module contract

A task module is a trusted, bounded single-file `.mjs` that exports `run(runtime)` and may export `meta`. Manager snapshots the source before execution and binds task idempotency to that snapshot hash.

Manager never imports a task module while installing it. A short-lived inspector child loads the snapshot, returns bounded JSON metadata, and is force-stopped on exit, error, or timeout; Manager hashes the snapshot again before registering it. This protects Manager availability from accidental top-level exits or waits, but it is not a sandbox for untrusted code. External installation is idempotent for the same SHA and returns `409 TASK_TYPE_CONFLICT` for a same-name different SHA. Only the internal seed path may explicitly replace a built-in task during an application upgrade.

```js
export const meta = { name: 'example', version: '1.0.0' };

export async function run({
  page, context, input, outputDir,
  action, cooldown, effects, semantic, handoff,
  progress, checkpoint, signal
}) {
  await action.goto(input.url, { waitUntil: 'domcontentloaded' });
  await progress({ current: 1, total: 1, message: 'Loaded target' });
  return { summary: 'Done', evidence: [{ kind: 'url', value: page.url() }] };
}
```

Each attempt replays the same internal effect journal. State-changing operations must use `action`; direct `page` access is observational and trusted Task Packs must not mutate through it. A `started` record without a durable terminal record is carried into the next attempt and blocks every new action until trusted task logic consumes its frozen checkpoint, inspects external state, and explicitly resolves that exact sequence as observed succeeded or observed not applied. Resume never clears an unknown outcome implicitly. Timeout covers setup, Playwright/browser/module startup, and task execution. Timeout, cancellation, and output-budget failure abort the task signal before bounded screenshot diagnostics, so the action facade rejects late operations before cleanup.

`semantic.snapshot()` builds one bounded, redacted ref/text view across up to sixteen Playwright Frames. A ref resolves only while its snapshot and page URL are current; navigation invalidates it. `semantic.click/fill/navigate` route through the same action/effect policy. Diagnostics persist the semantic view beside the viewport screenshot, allowing an Agent to inspect structure first and use pixels only where structure is ambiguous.

Task-type list responses contain compact metadata (`domains`, `intents`, `tags`, outputs, risk, preferred behavior, resume support, and Pack provenance) without the input schema. The full schema is returned only by describe. A Task Pack validates and inspects every candidate before one registry commit; conflicts cannot partially install a Pack.

`checkpoint(data)` persists an internal task/attempt/timestamp envelope capped at 8 MiB, while task code sees only the exact prior `data` from `checkpoint.read()`. Output and checkpoint are not one filesystem transaction; resumable modules therefore use deterministic per-unit outputs or stable-key deduplication instead of blind append-only writes. Diagnostic manifests are also attempt-bound so a recovered screenshot from an earlier failure cannot replace the current attempt's result artifact.

Returned business data is not streamed implicitly. Modules persist large results under `outputDir`, declare agent-visible relative artifacts in evidence, and return a compact summary. Public task views expose opaque artifact references instead of local paths. Declared artifact chunks are byte-preserving so structured files and hashes remain valid; declaring a file Agent-visible is therefore an explicit disclosure decision by trusted task code.

Authenticated Manager shutdown first rejects new mutations, keeps never-started queued work durable, marks active work interrupted, then drives Worker/browser cleanup. Hard operating-system termination, power loss, or a trusted synchronous infinite loop cannot be made equivalent to graceful shutdown by pure Node.js. Without a matching cleanup receipt, the Profile remains quarantined; persisted PIDs are observation evidence and are never used alone as a kill target.
