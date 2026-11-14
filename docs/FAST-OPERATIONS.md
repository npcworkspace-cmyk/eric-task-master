# Fast operations

The new operations path keeps one existing Task Master task, worker and Chrome context alive across commands. The main Agent decides strategy and text; bounded local commands handle mechanical actions, scoped observation and condition waiting. No second model is installed or called.

This source delivery supports isolated, explicitly selected Task Master Profiles. Signed-in account administration still defaults to the user's real local browser. A supported browser-use host adapter is not bundled: selecting `local-browser` fails with `BROWSER_ADAPTER_UNAVAILABLE` and offers connecting the selected local browser through a supported adapter or explicitly choosing a Task Master Profile. It never silently launches a replacement or attaches arbitrary CDP.

## Modes and page ownership

There are two execution modes: `batch` (a finite action group and then finish) and `operations` (keep the task waiting for commands/events). A prompt's explicit mode applies to that task and takes precedence without changing saved Profile policy. Otherwise a saved `batch`/`operations` default applies; `auto` consults the declared Skill mode or waiting/follow-up intent, then defaults to a finite batch. `auto` is a selection policy, not an execution engine. Existing one-off scripts remain supported.

Use `taskmaster profiles mode PROFILE --mode auto|batch|operations` to change a saved default. For an individual operation, put `mode` in start input. A Skill can instead declare `skillMode: "operations"` or an explicit waiting/follow-up `intent` under auto selection. Neither a mode change nor page content can expand authorization or switch account/Profile.

`ops takeover` and `ops pause` lock automated mutation while preserving the current browser. They are control states, not an additional execution mode. `ops resume` is explicit; all old target references are invalidated and a fresh observation is required. An in-flight write whose result cannot be confirmed becomes unknown and must be reconciled before continuation.

## Start and continue

Every example is a schema example, not permission to operate a real account. Replace resources only after the user selects the browser/account and grants scope. Use an isolated `--state-dir` on every command for tests; do not use an installed user's Profile for a test.

```json
{
  "goal": "Inspect a selected test resource and wait for decisions",
  "businessKind": "site",
  "mode": "operations",
  "browserSelection": { "kind": "profile", "profileId": "EXPLICIT_TEST_PROFILE_ID" },
  "authorization": {
    "accountId": "test-account", "resourceIds": ["test-resource"],
    "origins": ["http://127.0.0.1:12345"],
    "allowedActions": ["navigate", "site.prepare", "site.configure"],
    "expiresAt": "REPLACE_WITH_EXPLICIT_FUTURE_UTC_TIMESTAMP"
  },
  "identity": {
    "account": { "selector": "[data-account-id]", "attribute": "data-account-id" },
    "resource": { "selector": "[data-resource-id]", "attribute": "data-resource-id" }
  }
}
```

```text
taskmaster ops start --input @start.json --json
taskmaster ops command OP_ID --input @observe.json --json
taskmaster ops get OP_ID --json
taskmaster ops events OP_ID --after CURSOR --wait-ms 30000 --json
taskmaster ops ack OP_ID --input @receipt.json --json
taskmaster ops decide OP_ID --input @decision.json --json
```

Start returns the operation ID and existing task ID. Commands return a durable reservation, not fabricated browser completion; retrieve the matching command's reply through `ops get`. Reusing a command ID with different content is a conflict. Keep IDs/cursors in a secret-free handoff receipt and continue the same task while it is alive.

An observation command is `{ "commandId":"read-1", "kind":"observe", "payload":{ "scope":"#resource", "maxChars":6000, "maxItems":40 } }`. Optional `fields`, `offset` and `baselineId` support expansion/deltas. Each item's `textRange` identifies original length and the exact returned range; pass its `textContinuation` as the next scoped observation payload to read omitted text using `textOffset`. A 2,000-character item is not reported complete when a longer rule/context remains. Every omission is identified; invalid/mismatched baselines explicitly reset. `items[].ref` is bound to page identity and revision. Navigation, DOM changes, takeover and tab changes invalidate old targets. Context that cannot fit safely returns `CONTEXT_INSUFFICIENT`; it is not silently discarded. Every protected read, local observer and reconciliation checks current Manager authorization and actual account plus resource evidence. Initial `about:blank` permits only empty bootstrap metadata and an explicitly authorized navigation; it does not waive checks on the destination or expose a foreign account page.

A batch includes `pageId` and `pageVersion` from a fresh observation plus `payload.preconditions`, `stopConditions`, 1–16 named `actions` and nonempty `verify`. Target by selector, exact role/name, exact text or a fresh reference; all matches must be unique and actionable. Primitives are read/locate, click, fill, select, scroll, key, explicit HTTP(S) navigation and local wait. There is no page-supplied arbitrary JavaScript execution interface. Use expected navigation and positive expected-state conditions for effects, and a stable identity/resource precondition rather than a previous page URL when navigation is expected within a group.

Each mutating action is checked against current authorization and actual page account/resource evidence. The Manager durably acknowledges `prepared` and then `initiated` before the effect; final verification produces `confirmed` or `unknown`. Lost acknowledgement, unexpected dialog/navigation, permission/account change, cancellation after submission or unverifiable save blocks replay. A failed second step also preserves uncertainty from earlier initiated steps. This is reconciliation-based duplication protection, not an exactly-once external-system guarantee. Preparation actions may be explicitly marked `effect:false`; this distinguishes local form preparation from a business submission and does not waive origin/account/action authorization.

Advertising actions preserve before/after, currency, daily/lifetime basis, fields, data range/as-of/attribution and observation window. Page `businessContext` selectors can require exact currency/budget basis and compare action context to observed fields. Configure authorization limits for actual business adjustments (fields, min/max, per-change/cumulative change, age/frequency/daily/cooldown). Website records preserve original values and rollback steps, and keep saved/accepted/propagating/effective distinct. Social records retain community/post/conversation/reply/follow-up identifiers and community rules. The helpers in `operations-workflows.mjs` encode mechanics only; an explicit main-Agent decision supplies content and strategy.

## Local waits, events and evidence

`kind:wait` accepts a bounded `condition` (unique actionable target, exact text/value/attribute, visible/hidden/absent state, or URL), `timeoutMs` and optional `pollMs`. Download waits are supported when registered before the download event; do not assume a late wait proves a prior download. `watch:true` registers up to eight local condition observers, with a `watchId`, event type, deadline and optional one-shot behavior. Watchers read current documents after refresh/navigation; health checks report their checks and last successful observation. Quiet conditions do not generate main-Agent calls. Login/permission conditions, when configured, plus account/context loss and disconnection produce distinct safety events rather than guessed recovery. `wait` with `health:true` returns watcher/page/reference/baseline/listener counts. `cancelWatch` removes a named watcher.

Screenshots are opt-in: supply a unique target or validated clip. They are private bounded artifacts, not default model input. Password/email/OTP and `data-private` regions are masked, but other visible data can remain; review before sharing. Observations omit credential-input values, private regions and executable page contents; stored structured data uses the existing redactor. Task-written arbitrary files remain subject to review.

Event lifecycle is pending → delivered → received → handled. A receipt is not a decision. An explicitly configured absolute executable plus argument array can consume bounded JSON on stdin and return an identified accepted delivery receipt. Failed dispatch retains the same pending event for bounded retry. The fixture adapter demonstrates process plumbing only; it does not prove that a closed or ended Codex session can wake up. With no supported adapter, events remain available for a live Agent's bounded CLI long poll. Actual host token/cost usage that is unavailable is reported unobservable; character length is not substituted for tokens.

Schedules store UTC instants with an explicit IANA timezone, allowed window, per-window cap, expiry and `once`/`skip` misfire policy. Resume coalesces missed work instead of bursting a backlog. Run/duration/host-call limits are enforced; token/cost enforcement requiring unavailable measurements pauses rather than pretending to enforce spend.

## Recovery and total stop

Read `ops get` and pending events after any disconnect or restart. Never replay an initiated/unknown action. `ops reconcile` submits a reserved readback command with `actionIds` and positive `verify` conditions. Optional `refresh:true` performs a same-page read-only GET refresh; `url` explicitly reopens an authorized readback entry after a restarted browser. The actual account/resource must still match. Unresolved or manually conflicting values stay unresolved; changing a selector or invoking resume is not permission to overwrite them. Resume after a deliberate takeover requires current authorization, reconciled writes and a fresh observation.

Use `ops revoke OP_ID`, `ops stop OP_ID` or `ops stop-all`. The last affects operations sessions only, not unrelated script jobs. Existing task/Profile leases and process containment perform shutdown. State/evidence remain available; this does not undo already accepted external actions. Upgrading the installed runtime, replacing existing Profiles or publishing a release requires separate permission.

## Reproducible local evidence

```text
node scripts/acceptance-fast-operations.mjs ABSOLUTE_OUTPUT_DIRECTORY
node scripts/acceptance-fast-recovery.mjs ABSOLUTE_OUTPUT_DIRECTORY
node scripts/soak-fast-operations.mjs ABSOLUTE_OUTPUT_DIRECTORY
```

`TASKMASTER_FAST_OUTPUT` may select the output directory. Acceptance starts an isolated Manager and Profile plus a loopback stateful fixture and exercises the real CLI → Manager → worker → Chrome → durable ACK path. It covers social reply/follow-up, Google-labelled and Meta-labelled simulated budgets, website save/readback/propagation, scheduled/main-Agent decision continuation, unknown-result protection, modes and page takeover. It never accesses a real social/ad/domain account. Reports, CLI timings, isolated state, fixture state and screenshot artifacts are retained; cleanup success is reported separately.

The soak defaults to 24 actual hours with resource/heartbeat samples every minute. A short smoke can set `TASKMASTER_SOAK_DURATION_MS=180000` and `TASKMASTER_SOAK_SAMPLE_MS=5000`; it never satisfies the real 24-hour gate. `soak-status.json` identifies the supervisor PID, actual elapsed time, current operation/task and injected scenarios; `resource-samples.jsonl` preserves measured owned-process resources, page/listener/watcher counts and queue size. `soak-report.json` separates functional success from `preliminary24HourGatePassed`. Long supervision/heartbeat gaps or computer sleep invalidate the continuous gate, even if wall-clock time later exceeds 24 hours. Deliberate controlled restart is recorded separately from an unexplained gap. SIGINT/SIGTERM or a `STOP` file in the output directory requests bounded cleanup; the shared installed Manager is never stopped.

Performance reports compare confirmed same-page mechanical work with the same positive verification, first versus warm phases, median/tail CLI/browser wall time and command round trips. Model calls, actual input/output tokens and reasoning latency remain unobservable in the deterministic test driver. Real platform compatibility, real business outcomes, native closed-host dispatch, installed-runtime validation and publication are separate unverified gates unless their own evidence is supplied.
