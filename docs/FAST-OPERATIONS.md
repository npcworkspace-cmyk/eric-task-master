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

Replay protection applies to Task Master's actions, not every browser or website transport retry. In an isolated Chrome 157 diagnostic, one click and one page `fetch` produced three server-side POST effects when the server committed and disconnected before sending response headers. Unknown-state reconciliation prevented additional Task Master actions but could not undo those initial effects. Preserve this negative evidence: count independently observed external effects where possible, do not equate one ledger action with one server submission, and do not claim that non-idempotent external writes are guaranteed exactly once. This limitation does not waive the strict zero-duplicate acceptance gate.

Advertising actions preserve before/after, currency, daily/lifetime basis, fields, data range/as-of/attribution and observation window. Page `businessContext` selectors can require exact currency/budget basis and compare action context to observed fields. Configure authorization limits for actual business adjustments (fields, min/max, per-change/cumulative change, age/frequency/daily/cooldown). Website records preserve original values and rollback steps, and keep saved/accepted/propagating/effective distinct. Social records retain community/post/conversation/reply/follow-up identifiers and community rules. The helpers in `operations-workflows.mjs` encode mechanics only; an explicit main-Agent decision supplies content and strategy.

## Local waits, events and evidence

`kind:wait` accepts a bounded `condition` (unique actionable target, exact text/value/attribute, visible/hidden/absent state, or URL), `timeoutMs` and optional `pollMs`. Download waits are supported when registered before the download event; do not assume a late wait proves a prior download. `watch:true` registers up to eight local condition observers, with a `watchId`, event type, deadline and optional one-shot behavior. Watchers read current documents after refresh/navigation; health checks report their checks and last successful observation. Quiet conditions do not generate main-Agent calls. Login/permission conditions, when configured, plus account/context loss and disconnection produce distinct safety events rather than guessed recovery. `wait` with `health:true` returns watcher/page/reference/baseline/listener counts. `cancelWatch` removes a named watcher.

Screenshots are opt-in: supply a unique target or validated clip. They are private bounded artifacts, not default model input. Password/email/OTP and `data-private` regions are masked, but other visible data can remain; review before sharing. Observations omit credential-input values, private regions and executable page contents; stored structured data uses the existing redactor. Task-written arbitrary files remain subject to review.

Event lifecycle is pending → delivered → received → handled. A receipt is not a decision. An explicitly configured absolute executable plus argument array can consume bounded JSON on stdin and return an identified accepted delivery receipt. Failed dispatch retains the same pending event for bounded retry. The fixture adapter demonstrates process plumbing only; it does not prove that a closed or ended Codex session can wake up. With no supported adapter, events remain available for a live Agent's bounded CLI long poll. Actual host token/cost usage that is unavailable is reported unobservable; character length is not substituted for tokens.

Schedules store UTC instants with an explicit IANA timezone, allowed window, per-window cap, expiry and `once`/`skip` misfire policy. Resume coalesces missed work instead of bursting a backlog. Run/duration/host-call limits are enforced; token/cost enforcement requiring unavailable measurements pauses rather than pretending to enforce spend.

## Recovery and total stop

Read `ops get` and pending events after any disconnect or restart. Never replay an initiated/unknown action. `ops reconcile` submits a reserved readback command with `actionIds` and positive `verify` conditions. Optional `refresh:true` performs a same-page read-only GET refresh; `url` explicitly reopens an authorized readback entry after a restarted browser. The actual account/resource must still match. Unresolved or manually conflicting values stay unresolved; changing a selector or invoking resume is not permission to overwrite them. Resume after a deliberate takeover requires current authorization, reconciled writes and a fresh observation.

For an originally recorded HTTP(S) navigation explicitly marked `effect:false`, the recorded resource can describe the source page. Its recovery must read the exact original destination URL, verify the original expected URL condition, and observe the same account plus a currently authorized destination resource. The source identity remains intact and `destinationReadback` records the actual destination separately. This narrow rule cannot be claimed by a new reconcile declaration and does not relax resource matching for external writes or non-navigation preparation.

Use `ops revoke OP_ID`, `ops stop OP_ID` or `ops stop-all`. The last affects operations sessions only, not unrelated script jobs. Existing task/Profile leases and process containment perform shutdown. State/evidence remain available; this does not undo already accepted external actions. Upgrading the installed runtime, replacing existing Profiles or publishing a release requires separate permission.

## Optional cursor and native-dialog acknowledgement

`ops start` accepts optional boolean `showCursor`; operations default on and finite batches default off. An explicit value overrides only that operation and survives recovery, not a Profile preference. Toggle it with `ops update OP_ID --input '{"showCursor":false}' --json` or the checkbox on the existing built-in operation task card. The update reports application only after the worker applies the view preference. It never resumes an operation, releases takeover or authorizes an effect.

The modest orange/white pointer and brief click ripple indicate controlled actions without moving the real OS cursor or focusing a window. Pointer movement is decorative and is not awaited to completion. Exact internally owned overlay nodes are excluded from DOM revision, observations, target references and local watchers; site content is not globally excluded. Normal page/region screenshots temporarily hide the pointer and restore it only if still enabled and active, including failed-capture cleanup. Pause, takeover, tab/navigation cleanup and task completion remove old overlays. Raw free-form Playwright/CDP scripts are not universally tracked. Coordinates come from actual uniquely resolved viewport boxes; iframe helper calibration does not add arbitrary frame-interior targets to the operations protocol.

Unexpected native alert/confirm/prompt is mechanically dismissed, never automatically accepted or supplied secret input. Dismissal leaves `UNEXPECTED_DIALOG`; re-observation, ordinary resume or switching tabs does not clear that safety marker. After judging the current scene, submit a real control command using fresh observation identity/version:

```json
{
  "commandId": "review-dialog-1", "kind": "control",
  "pageId": "FRESH_PAGE_ID", "pageVersion": "FRESH_PAGE_VERSION",
  "payload": { "action": "acknowledge-dialog", "reason": "State the actual reviewed interruption and the decision to continue or refuse" }
}
```

The worker rechecks current origin/account/resource and the Manager durably audits this exact scene before it clears only that page's dialog marker. Any initiated/unknown external effect blocks acknowledgement until genuine same-resource reconciliation. Explicitly non-effect preparation can be abandoned only within the matched scene, never falsely confirmed; other unresolved scene records keep their uncertainty lock. Acknowledgement does not release takeover, clear unrelated unsafe state or retry an interrupted action. A new observation is required afterward. Region screenshots plus parent-page close controls can support the isolated iframe popup case; accepting arbitrary iframe actions or filling a native prompt is not supported by this addition.

## Reproducible local evidence

```text
node scripts/acceptance-fast-operations.mjs ABSOLUTE_OUTPUT_DIRECTORY
node scripts/acceptance-fast-recovery.mjs ABSOLUTE_OUTPUT_DIRECTORY
node scripts/acceptance-cursor-dialog.mjs ABSOLUTE_OUTPUT_DIRECTORY
node scripts/soak-fast-operations.mjs ABSOLUTE_OUTPUT_DIRECTORY
```

`TASKMASTER_FAST_OUTPUT` may select the output directory. Acceptance starts an isolated Manager and Profile plus a loopback stateful fixture and exercises the real CLI → Manager → worker → Chrome → durable ACK path. It covers social reply/follow-up, Google-labelled and Meta-labelled simulated budgets, website save/readback/propagation, scheduled/main-Agent decision continuation, unknown-result protection, modes and page takeover. It never accesses a real social/ad/domain account. Reports, CLI timings, isolated state, fixture state and screenshot artifacts are retained; cleanup success is reported separately.

The legacy `soak-fast-operations.mjs` defaults to 24 actual hours and retains its original `preliminary24HourGatePassed` field for compatibility; it is no longer this round's acceptance gate. It can still exercise deterministic fault coverage with `TASKMASTER_SOAK_DURATION_MS=180000` and `TASKMASTER_SOAK_SAMPLE_MS=5000`. Its short script-driven success is not a live main-Agent decision or a substitute for the user-revised test below.

## Current gate: two real eight-hour live lanes

The user explicitly replaced the former 24-hour gate with two concurrent, separately isolated eight-hour experiments. Do not report either as complete before its actual result exists:

```text
node scripts/acceptance-live-chaos.mjs ABSOLUTE_BUSINESS_LANE_OUTPUT
node scripts/acceptance-live-popups.mjs ABSOLUTE_POPUP_LANE_OUTPUT
```

Each lane has its own Manager state, Profile, loopback fixture, operation/task and seeded plan. Default `TASKMASTER_LIVE_DURATION_MS` is 28,800,000; a 120,000-ms smoke with `TASKMASTER_LIVE_SAMPLE_MS=5000` is intentionally compressed and can never satisfy `eightHourGatePassed`. Use `TASKMASTER_LIVE_SEED` to reproduce a bounded plan of 24 twenty-minute slots with seeded 2–12-minute arrival jitter. Each lane's eight families occur three times. One pending challenge per lane is allowed; subsequent slots skipped because of an unresolved request or `HOLD` remain missing coverage, never fabricated successes.

The supervisor injects, observes, measures and checks independent fixture outcomes; it does not make semantic choices or create approved root answers. Read `status.json` and `requests/<encoded-challengeId>.json`, inspect compact `ops events` / `ops get OP_ID --command COMMAND_ID` plus needed page evidence, then make actual CLI ack/decide/command/refusal actions. Only after those commands complete, write the request's absolute `decisionPath` with `{schemaVersion:1,challengeId,actor:"root-main-agent",observedAt,decisionAt,summary,disposition,commandIds,eventIds,evidenceRefs}`. Disposition is execute/refuse/defer/stop. The driver requires matching durable handled events, real command receipts and the independent page result; a JSON assertion alone is not success. Windows filenames encode the logical colon-containing challenge ID rather than treating it as a path or alternate stream.

Business challenges exercise change, stale context, insufficient data, uncertainty, login/identity, takeover and declared restart. Popup challenges cover benign overlays, risky consent, destructive confirmations, security challenges, new tabs, iframe parent controls and native alert/confirm/prompt. Native mechanical cancellation is labelled separately from root judgement; root must explicitly review and legally acknowledge the scene before claiming safe continuation. Correct refusal is a safety result, not a claim that login was bypassed or a popup accepted. At least one genuine root decision per family per lane is required. No real account, ad spend, domain configuration or credentials are used.

Keep `run-manifest.json`, append-only `challenges.jsonl`, requests/decisions, observations, `resource-samples.jsonl` and `report.json`. Timestamps distinguish injection, detection, Agent queue, decision, first recovery action, verification and actual resume. Failures and null metrics remain in denominators. The popup lane uses monotonic elapsed time as well as UTC, binds all source `.mjs` files plus package/lock hashes, rechecks those hashes, and rejects unexplained supervision gaps above 120 seconds. A declared restart is a new continuity segment, not an uninterrupted browser session. Source changes require a new evidence segment and root's explicit gate decision.

An output-directory `STOP` file or SIGINT/SIGTERM requests scoped cleanup; `HOLD` stops further injection but keeps monitoring and existing requests visible. Root stays in the current chat to consume both lanes; native closed-Codex wakeup is not claimed. A short smoke, mere process liveness, automatic popup dismissal or an unresolved final request cannot satisfy the dual eight-hour gate. Both reports must separately show real duration, required family/root coverage, zero unauthorized/duplicate effects and clean isolated shutdown.

Performance reports compare confirmed same-page mechanical work with the same positive verification, first versus warm phases, median/tail CLI/browser wall time and command round trips. Model calls, actual input/output tokens and reasoning latency remain unobservable in the deterministic test driver. Real platform compatibility, real business outcomes, native closed-host dispatch, installed-runtime validation and publication are separate unverified gates unless their own evidence is supplied.
