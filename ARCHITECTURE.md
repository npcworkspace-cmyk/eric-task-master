# eric-task-master architecture

## Invariants

1. Browser work is executed only through Playwright APIs.
2. The same-origin Web Dashboard is the only human control plane. Login state is created directly inside a persistent Playwright Profile.
3. Profiles are shared resources for trusted local Agents. Every Profile has at most one live lease, so same-Profile work queues instead of colliding. A persistent Profile owns browser state; an ephemeral Profile is a clean task-scoped context template and retains none after confirmed cleanup.
4. Every task has a state, heartbeat, progress record, output directory, and fail-closed cleanup proof. An unconfirmed browser close blocks the Profile lease.
5. Unknown action outcomes are inspected before retrying.
6. Authentication material never appears in agent-visible responses or logs.
7. Core runtime remains site-agnostic; specialized Skills provide site behavior.
8. Each Agent host starts its own STDIO MCP bridge with a stable scoped identity; all bridges reuse the same Manager, and no host configuration contains Manager, browser, or account credentials.
9. Agent-visible task results contain bounded summaries and declared artifacts only after completion verification, never local execution paths.
10. A persistent Ed25519 Manager identity authenticates the loopback endpoint before an admin or scoped Agent credential is sent.
11. The Owner Console is a deliberately small human workbench: Profile management plus task progress and pause, resume, cancel, or record deletion. Reports, artifacts, diagnostics, and Agent coordination remain protocol capabilities rather than Dashboard surfaces.
12. Owner commands are durable and revision-checked. An offline Agent can receive them when it reconnects, but Manager does not claim to wake an arbitrary closed host process.

## Components

- `src/manager.mjs`: loopback HTTP manager and API.
- `src/runtime/task-worker.mjs`: isolated Playwright task process.
- `src/cli.mjs`: fixed Agent entrypoint.
- `src/mcp/`: standard STDIO MCP server and scoped Manager client.
- `src/registration/`: transactional, per-host MCP configuration adapters.
- `dashboard/`: full management interface served by the manager.
- `skills/eric-task-master/`: progressive-disclosure Agent instructions.

## Manager API v1

All responses are JSON. Loopback is the only supported bind address. Manager admin, scoped Agent, and persistent Owner Console sessions have separate credentials. The Owner Console acts with local Manager authority while Agent task histories remain principal-scoped.

The first Manager state initialization persists an Ed25519 key pair beside the protected admin credential. `POST /v1/identity/challenge` signs a caller-generated 256-bit nonce together with the exact service, version, API version, host, and listening port. CLI and MCP verify that proof against the public key pinned in local state before sending the Manager admin credential. A port occupant, wrong key, stale signature, or binding mismatch fails closed.

### Health and authorization

- `GET /v1/health`
- `POST /v1/identity/challenge`
- `POST /v1/agents/issue`
- `GET /v1/agents`
- `POST /v1/agents/:id/actions`
- `POST /v1/dashboard/authorize`
- `POST /v1/dashboard/session`
- `POST /v1/dashboard/logout`
- `GET /v1/dashboard/summary`

`connect` verifies the Manager identity pinned in local state, uses the protected Manager credential to mint one short-lived Dashboard bootstrap code, and returns a Dashboard URL containing only that one-use code. The page exchanges it once for a hashed, restart-persistent Owner session delivered as an `HttpOnly`, `SameSite=Strict` cookie, then removes the code from browser history. The fixed bookmark is `http://127.0.0.1:19946/dashboard`; no user-visible code entry or repeated binding step exists. State-changing cookie requests require the exact Manager origin. Logout revokes the server-side session.

### Profiles

- `GET /v1/profiles`
- `POST /v1/profiles`
- `PATCH /v1/profiles/:id`
- `DELETE /v1/profiles/:id`
- `POST /v1/profiles/:id/open`
- `POST /v1/profiles/:id/close`

`kind` and `browserEngine` are immutable. A new persistent Profile defaults to the locally installed stable Chrome channel plus `human`; a new ephemeral Profile defaults to lockfile-pinned Playwright Chromium plus `auto`. Both kinds may select `fast`, `auto`, or `human` at Profile level. Legacy `adaptive` values migrate in place to `auto`; Profile browser data is not moved. Legacy `browserChannel` values migrate only through the explicit map `null|chromium -> chromium` and `chrome -> chrome`; every other value fails closed. Workers use one resolver and never fall back to another engine. A manually opened persistent Profile is always visible; `headless` affects task launches only.

All Profiles are visible and usable by every trusted local Agent registered with this Manager. Profile records have no creator or access-owner concept. The v4 migration removes legacy `ownerClientId`, `createdBy`, and `access` fields in place without moving `userDataDir`, so existing browser state remains intact. Task records and artifacts remain scoped to the Agent that started them; Profile sharing does not merge task histories. A `persistent` Profile can be opened from the Owner Console so the user can sign in directly in its Playwright window; its native `userDataDir` retains that state. An `ephemeral` Profile cannot be opened manually and launches `browser.newContext()` inside each task; cleanup closes the context and owning browser.

Agent authorization is scoped to one stable registered MCP client ID and role tuple. Internal and legacy-reserved Manager, Dashboard, extension, task, Profile, and session principal names/prefixes cannot be issued as Agent IDs. Manager persists an Agent Registry with display name, presence, last-seen time, current work, Profiles in use, and queue depth—never Agent tokens or token hashes. The Owner can revoke or restore an Agent; restore grants permission but does not fake online presence. Different host registrations/client IDs are separate task principals, while all share the Profile catalog. Processes under the same OS user are trusted peers; mutually untrusted tenants require separate OS users, sandboxes, or machines. Manager credential rotation still invalidates every scoped Agent token.

### Tasks

- `GET /v1/task-types`
- `GET /v1/task-types/:id`
- `POST /v1/task-types/:id/actions` (deprecate or restore; Manager/Owner only)
- `POST /v1/task-types/install` (Manager admin only)
- `POST /v1/task-packs/install` (Manager admin only, transactional batch)
- `GET /v1/tasks`
- `POST /v1/tasks`
- `GET /v1/tasks/:id`
- `DELETE /v1/tasks/:id` (terminal, cleanup-settled records; Manager/Owner only)
- `POST /v1/tasks/:id/continue`
- `POST /v1/tasks/:id/resume`
- `POST /v1/tasks/:id/cancel`
- `POST /v1/tasks/:id/actions` (pause, resume, terminate)
- `POST /v1/tasks/:id/commands` (ask or modify)
- `POST /v1/tasks/:id/commands/:commandId` (Agent response)
- `GET /v1/tasks/:id/timeline`
- `POST /v1/tasks/:id/revision` (queued input only)
- `POST /v1/tasks/:id/report` (Agent-authored human report)
- `POST /v1/agent/inbox/claim`
- `GET /v1/tasks/:id/artifacts`
- `GET /v1/tasks/:id/artifacts/:artifactId`

### Dashboard

- `GET /dashboard`
- `GET /dashboard/*`
- `POST /v1/dashboard/authorize`
- `POST /v1/dashboard/session`
- `POST /v1/dashboard/logout`
- `GET /v1/dashboard/summary`

Dashboard URLs never contain the Manager admin credential. The first authorized link creates the persistent Owner cookie; after that the fixed Dashboard URL works directly across Manager restarts until logout, expiry, or revocation. A `401` requests a new bootstrap link. A `403` is shown inline and does not discard the valid session or the last rendered state.

The Dashboard has exactly two primary views: Tasks and Profiles. Task cards expose the immutable display name, state, current progress, Profile, active execution time, cumulative cooldown time, total elapsed time, and only the applicable lifecycle controls. It does not fetch or render the Agent Registry, reports, artifacts, timeline, diagnostics, or Agent inbox.

## Profile states

`idle -> starting -> open -> idle`; an unconfirmed browser close becomes `error` and retains its cleanup-required lease.

An active task changes the state to `leased`. A stale non-browser lock is recovered only after the recorded process is proven absent. Browser-bearing task/Profile leases additionally require a matching private cleanup receipt; Worker PID disappearance alone never proves browser closure.

## Task states

`queued -> acquiring_profile -> starting_browser -> running -> verifying -> completed`

Manager owns a bounded FIFO scheduler. Different Profiles may occupy independent slots; work for the same Profile remains queued until the previous Worker exits and its lease is released. Queue position/reason are public. Manager restart preserves never-started queued tasks and fails interrupted active work closed.

Task and manually opened Profile leases renew through a serialized barrier. Finalization first stops new renewals, drains the in-flight renewal, then releases exactly once. A manually opened Profile is treated as busy; a dead owner without cleanup proof blocks queued work instead of being mistaken for ordinary contention. Legacy `session-import:*` leases are migration-only: a matching cleanup receipt may release them, while missing proof keeps the Profile quarantined.

Side states are `waiting_user`, `cooling_down`, `recovering`, `pause_requested`, `paused`, `cancel_requested`, `failed`, and `cancelled`. Pause is cooperative: the in-flight action settles, later action/progress/checkpoint/completion boundaries wait, diagnostics are captured, and resume first checks that the live page is responsive. A running terminate request becomes `cancel_requested` and reaches terminal `cancelled` only after browser closure, Worker exit, and lease release are all proved. Terminal tasks always pass through cleanup.

Every task has a stable `jobId` and monotonic `revision`. Owner commands use `commandId + expectedRevision`, making retries idempotent and concurrent edits explicit. Running input is immutable; only queued input can be revised. Ask/modify messages live in a durable Agent inbox and can be acknowledged, applied, or rejected. Active waits return early when commands arrive; an offline Agent sees them after reconnecting and claiming its inbox.

Task creation accepts one bounded `taskLabel` containing only the concrete action, object, and scope. Manager combines a stable host identity, that label, and its own UTC creation timestamp into the immutable `displayName` (`Agent-task-createdAt`); the Agent display identity must never be changed per task. Timing is Manager-derived: total time spans creation to terminal completion (or now), execution time spans browser attempts with cumulative cooldown removed, and cooldown time accumulates actual elapsed cooldown periods, including interrupted ones.

Dashboard deletion is a logical record deletion, never task cancellation. It is allowed only after terminal state and confirmed browser, Worker, and Profile cleanup, is serialized with other controls, and requires the current revision. Public reads immediately hide the record, while its minimal idempotency tombstone remains private so deleting history cannot make a previously executed external action replayable with the same key.

The Agent may publish a bounded, human-readable task report with a title, summary, and sections. Reports remain available to Agent and API consumers, but the intentionally minimal Owner Console does not render them. This preserves delivery and audit compatibility without turning the Dashboard into a second reporting product.

Heartbeat and progress are separate clocks. Heartbeat proves Worker liveness. `progressAt` proves application work advanced. The default stall detector requests screenshot plus semantic diagnostics after two minutes without progress and fails/cleans up after ten minutes of continued silence; explicit `waiting_user` and `cooling_down` states are exempt. Diagnostic capture is best-effort when the Worker or page event loop is itself unresponsive.

`waiting_user` is an in-process handoff, not a new task. The Worker captures diagnostics, publishes one bounded request ID, and waits. Only a matching continuation from the owning Agent/authorized Dashboard resumes the same Worker; timeout or cancellation fails closed and cleanup closes its browser.

`completed` is never accepted directly from a Worker. A Worker completion claim first enters `verifying`; Manager then validates the bounded result shape, every declared agent-visible artifact, confirmed browser closure, Worker exit, and Profile lease release. The verified artifact size and SHA-256 anchors are rechecked on reads and idempotent replays. Until this succeeds, result data and result artifacts remain private; a changed anchor becomes `TASK_COMPLETION_INTEGRITY_FAILED`. A failed initial gate becomes `TASK_COMPLETION_GATE_FAILED`.

A failed task with a stable checkpoint can be resumed only by its original role/client owner through an explicit request with a stable `resumeKey`. Resume keeps the same task ID, input, timeout, output directory, checkpoint, and original module snapshot; increments `attempt`; and appends bounded attempt history. Manager freezes the verified checkpoint into a private attempt-scoped input. The resumed Worker must consume that exact snapshot before any browser action, checkpoint replacement, or unknown-effect resolution. The same key is idempotent. A non-failed task, unsettled cleanup, missing/unstable checkpoint, missing persisted context, or changed module hash fails closed. Modules must inspect current site state before repeating any external action whose outcome was unknown.

## Behavior policies

- `fast`: the complete visible action path with compressed central timing.
- `human`: the same complete visible action path at natural central timing.
- `auto`: balances speed and caution, uses a short cautious tier for ordinary dynamic signals, and uses bounded guarded human pacing after occlusion, timeout, uncertain navigation, action failure, or rate limiting. Stronger signals retain a larger guarded-action budget; successful actions decay back toward fast. No tier retries an unknown effect automatically.

Behavior is owned by the Profile and task creation accepts no override. Both Profile kinds expose all three modes. Every visible action facade in every mode uses rendered traversal, bounded curved pointer motion and corrections, safe in-target click offsets and press duration, per-character keyboard rhythm, keyboard-driven native selection, segmented eased scrolling, and explicit reading dwell. Modes change only timing and guard depth; task-supplied click or typing delays cannot override the Profile policy. A Profile update is serialized, persisted, sent to its active Worker, and considered successful only after a matching application receipt. The Worker wakes any current pacing delay and applies the mode at the next JavaScript scheduling, pointer, key, or scroll boundary without replacing the task, attempt, Worker, browser, or Profile lease. If acknowledgement fails, the task fails closed instead of silently continuing under a stale policy. A live mode change never cancels a site-required cooldown. Public task state distinguishes an unconfirmed Profile selection from a Manager-received Worker receipt; the Dashboard renders only the latter as the actual running mode.

Every `full-human-v1` task type additionally makes those universal mechanics fail-closed and auditable: transition verification and the complete journey remain mandatory, and a ten-check interaction audit gates completion. The selected mode controls pacing and guard depth, not whether mechanics happen.
Pacing applies to visible interaction primitives such as pointer movement, clicking, typing, scrolling, navigation, and explicit reading dwell. Direct DOM extraction and file I/O remain unpaced. Task logic identifies the content and sequence; Human Journey centrally owns the physical action mechanics. It observes the rendered viewport after entries, traverses toward offscreen controls through bounded wheel gestures instead of instant locator positioning, and verifies page-changing clicks before continuing.

Each task output is bounded by a worker-enforced default budget of 512 MiB and 10,000 files. The worker checks it periodically and before progress, checkpoint, and completion; exceeding it fails the task without deleting existing output. A separate small reserve remains available for controlled diagnostic screenshots. Each automatic diagnostic screenshot is a complete, viewport-wide JPEG capped at 48 KiB, so MCP can return it as one valid image instead of mislabeled image fragments. The scanner never follows links and has independent entry/depth bounds. Checkpoint envelopes have an independent 8 MiB cap and are atomically rejected before replacing the last valid checkpoint; bulk records belong under `outputDir`.

Actions made through the task-scoped facade append an internal metadata-only effect journal (`started`, `succeeded`, or explicitly observed `failed`). Records contain only a sequence, fixed operation name, and timestamp—never selectors, values, URLs, or credentials. A Playwright exception leaves `started` pending because it cannot prove the website did nothing. That outcome must be inspected and must not be replayed blindly.

## Task module contract

A task module is a trusted, bounded single-file `.mjs` that exports `run(runtime)` and may export `meta`. Manager snapshots the source before execution and binds task idempotency to that snapshot hash.

Manager never imports a task module while installing it. A short-lived inspector child loads the snapshot, returns bounded JSON metadata, and is force-stopped on exit, error, or timeout; Manager hashes the snapshot again before registering it. This protects Manager availability from accidental top-level exits or waits, but it is not a sandbox for untrusted code. External installation is idempotent for the same SHA and returns `409 TASK_TYPE_CONFLICT` for a same-name different SHA. Only the internal seed path may explicitly replace a built-in task during an application upgrade.

```js
export const meta = {
  name: 'example',
  version: '1.0.0',
  interactionContract: 'full-human-v1'
};

export async function run({
  page, context, input, outputDir,
  journey, cooldown, effects, semantic, handoff,
  progress, checkpoint, signal
}) {
  await journey.open(input.url, { waitUntil: 'domcontentloaded' });
  await progress({ current: 1, total: 1, message: 'Loaded target' });
  return { summary: 'Done', evidence: [{ kind: 'url', value: page.url() }] };
}
```

Every Task Pack manifest and module declares `full-human-v1`. Contracted modules use `journey` for visible state changes; their `page`, `context`, Locator, Frame, and FrameLocator surfaces are observation-only proxies, and the legacy mutation facade is unavailable. Pack preflight also rejects common direct-action bypasses. This is defense in depth for trusted local modules, not an adversarial JavaScript sandbox: observation expressions remain trusted code.

Journey completion emits `interaction-audit.json` and reserves one evidence slot. Ten checks cover entry establishment, viewport observation, measurable visible target acquisition, pointer/click mechanics, keyboard cadence when input exists, segmented scrolling, verified pagination, absence of bypass violations, and settled steps. A failed audit rejects the task's completion claim. The contract improves repeatability and reviewability; it does not spoof fingerprints, bypass CAPTCHA, or guarantee that sites cannot identify automation.

Each attempt replays the same internal effect journal. State-changing operations flow through `journey` for contracted modules or `action` for legacy standalone modules. A `started` record without a durable terminal record is carried into the next attempt and blocks every new action until trusted task logic consumes its frozen checkpoint, inspects external state, and explicitly resolves that exact sequence as observed succeeded or observed not applied. Resume never clears an unknown outcome implicitly. Timeout covers setup, Playwright/browser/module startup, and task execution. Timeout, cancellation, and output-budget failure abort the task signal before bounded screenshot diagnostics, so the action facade rejects late operations before cleanup.

`semantic.snapshot()` builds one bounded, redacted ref/text view across up to sixteen Playwright Frames. A ref resolves only while its snapshot and page URL are current; navigation invalidates it. `semantic.click/fill/navigate` route through the same action/effect policy. Diagnostics persist the semantic view beside the viewport screenshot, allowing an Agent to inspect structure first and use pixels only where structure is ambiguous.

Task-type list responses contain compact metadata (`domains`, `intents`, `tags`, outputs, risk, resume support, interaction contract, Pack provenance, and lifecycle) without the input schema. The full schema is returned only by describe. Deprecated task types disappear from ordinary discovery, reject new execution, and may point to one active replacement; their immutable snapshots remain auditable. A Task Pack validates the Human Journey contract and inspects every candidate before one registry commit; conflicts cannot partially install a Pack. Five built-in scaffolds cover `single-page`, `paginated-list`, `list-detail`, `resumable-batch`, and `form-workflow`, and preflight validates modules in isolation without installing them.

`checkpoint(data)` persists an internal task/attempt/timestamp envelope capped at 8 MiB, while task code sees only the exact prior `data` from `checkpoint.read()`. Output and checkpoint are not one filesystem transaction; resumable modules therefore use deterministic per-unit outputs or stable-key deduplication instead of blind append-only writes. Diagnostic manifests are also attempt-bound so a recovered screenshot from an earlier failure cannot replace the current attempt's result artifact.

Returned business data is not streamed implicitly. Modules persist large results under `outputDir`, declare agent-visible relative artifacts in evidence, and return a compact summary. Public task views expose opaque artifact references instead of local paths. Declared artifact chunks are byte-preserving so structured files and hashes remain valid; declaring a file Agent-visible is therefore an explicit disclosure decision by trusted task code.

Authenticated Manager shutdown first rejects new mutations, keeps never-started queued work durable, marks active work interrupted, then drives Worker/browser cleanup. Hard operating-system termination, power loss, or a trusted synchronous infinite loop cannot be made equivalent to graceful shutdown by pure Node.js. Without a matching cleanup receipt, the Profile remains quarantined; persisted PIDs are observation evidence and are never used alone as a kill target.
