# Task Packs and specialized Skills

Read this reference when capability should be reusable across tasks or Agents. A Task Pack carries trusted task modules; a specialized Skill teaches an Agent when and how to use them.

## Create and install

```bash
node scripts/taskmaster.mjs task-packs scaffold ./catalog-monitor --name catalog-monitor --recipe paginated-list --json
node scripts/taskmaster.mjs task-packs validate ./catalog-monitor --json
node scripts/taskmaster.mjs task-packs install ./catalog-monitor --json
```

Choose exactly one built-in recipe: `single-page`, `paginated-list`, `list-detail`, `resumable-batch`, or `form-workflow`. Each recipe already contains the approved lifecycle, bounded progress, output persistence, completion evidence, cleanup-compatible control flow, checkpoint pattern, and mandatory `full-human-v1` journey contract. Start from the closest recipe instead of rewriting infrastructure. `task-packs validate` performs isolated module preflight without registering anything and reports every detected module error in one pass.

The manifest is named `taskpack.json`:

```json
{
  "name": "catalog-monitor",
  "version": "1.0.0",
  "title": "Catalog Monitor",
  "description": "One bounded workflow family.",
  "interactionContract": "full-human-v1",
  "tasks": [
    { "name": "catalog-monitor.collect.v1", "module": "tasks/collect-v1.mjs" }
  ]
}
```

## Minimal conventions

- Use one lowercase capability slug `<domain>-<capability>`, such as `catalog-monitor`. Give the specialized Skill and its Task Pack that same slug; do not append `-skill` or `-eric-task-master-skill`.
- Name a task type `<pack>.<verb>.vN` and its module `tasks/<verb>-vN.mjs`, for example `catalog-monitor.collect.v1` and `tasks/collect-v1.mjs`. A task type is immutable after registration. Use `.v2` only when its executable input, output, or meaning becomes incompatible.
- The Pack's semantic version describes the distributed Pack release and is independent of the task type's `.vN`. A Pack may move from `1.0.0` to `1.1.0` while retaining an unchanged `.v1` task type.
- At task start, supply a concise `taskLabel` as action + object + scope, such as `采集-目录条目-5页`. Do not put the Agent name or a timestamp in it; Manager adds stable Agent identity and creation time to the display name.
- Use bounded `camelCase` input fields that describe only business intent. Do not put runtime controls, Profile IDs, behavior modes, Agent IDs, cookies, tokens, or other credentials in task input.
- Keep applicable output names stable within one task type, preferring `result.json`, `records.jsonl`, `summary.json`, and `manifest.json`. A Pack need not emit every file, but it must not rename equivalent outputs between runs.

## Mandatory probe-before-scale gate

When no specialized Skill or registered task type covers a large request, first call MCP `taskmaster_scale_prepare` or CLI `task prepare-scale` against one representative entry URL. The runtime starts the built-in `surface-probe`; task authors do not recreate or vary that probe contract. Large means at least 20 independent pages/items, pagination or recursive expansion, an expected run above ten minutes, or unattended batch execution. Read its declared `surface-probe.json` artifact before authoring the Task Pack. Probe at most three URLs only when the site has materially different list/detail/account surfaces.

The probe is read-only and bounded. It samples headings, links, controls, page length, stable locator hints, pagination candidates, challenge signals, and a central rapid survey/backtrack journey, then recommends the closest recipe. It does not prove full-site coverage, grant permission, or defeat a login, CAPTCHA, press-and-hold challenge, or rate limit. A detected human-verification challenge creates a same-task `human_verification` handoff and waits for the Owner; no solver or bypass is used. After an explicit continuation, the probe observes again. CAPTCHA, rate limits, unreadable or omitted relevant frames, and challenge signals found by a bounded secondary frame scan keep `scaleAllowed` false. A dense main document or a hidden/decorative child frame that merely reaches the observation budget is reported as a warning instead of being mistaken for a site blocker. After the probe, customize the recommended recipe and run one bounded pilot whose result schema, checkpoints, rate policy, and completion evidence pass before raising the scale.

## Mandatory Human Journey contract

Every Task Pack declares `"interactionContract": "full-human-v1"`, and every Pack module declares `meta.interactionContract: 'full-human-v1'`. The Pack defines **what** to do, in what order, platform rate limits, when to checkpoint, and how to prove completion. The base runtime owns **how each visible browser action is physically performed and paced by the Profile's live mode**.

- Use `journey.open` for an entry URL or an explicit recovery entry.
- Use `journey.navigate` and `journey.nextPage` for links, detail pages, and pagination controls. Do not construct the next-page URL when the page exposes a usable Next control.
- Use `journey.click/fill/type/hover/scroll/survey/read/select/upload` for visible actions. On a static page, `journey.survey()` is one continuous downward wheel stream followed by one continuous return stream; its fine wheel events are motion frames rather than separately paused actions. Do not recreate its mechanics in a Pack.
- Use `page`, `context`, read-only locator methods, and `semantic` directly for fast reads, assertions, and bounded extraction. These reads are deliberately unpaced: `count`, `nth`, `innerText`, `textContent`, `inputValue`, `getAttribute`, `allTextContents`, and related Playwright reads do not acquire a visible-action lease. Contracted Packs cannot use arbitrary in-page `evaluate`/`evaluateAll`; JavaScript aliases, fetched functions, and prototype methods cannot form a trustworthy read-only boundary. Visible changes remain in `journey`.
- Do not accept behavior mode, pointer timing, scroll shape, or typing cadence in Pack input. Those mechanics are centrally owned and versioned.

In `fast`, `auto`, and `human`, the runtime still traverses rendered content with minimum-jerk wheel and pointer acceleration, rapid long-distance approach followed by precision acquisition, visible survey backtracking, in-target clicks, explicit per-character keyboard cadence, bounded reading dwell, verified visible transitions, and an Agent-visible `interaction-audit.json`. `fast` compresses time but keeps a non-zero keyboard cadence and the same motion topology. The selected Profile mode changes speed and caution, not the required journey. Completion fails unless all ten journey checks pass. This is a reliability and consistency contract, not fingerprint spoofing, CAPTCHA bypass, or a guarantee that a website cannot identify automation.

For independent items in a batch, opening each supplied URL is a valid new entry. Within one item, use visible site controls for pagination and drill-down. A direct URL may be used as a checkpoint-recovery entry when the previous rendered page no longer exists; record that recovery in task progress or coverage.

## Mandatory extension coexistence contract

This contract applies to every Task Pack that can run in a persistent Profile where the Owner has enabled installed browser extensions.

- **PACK-EXT-01 — equal ownership:** Task Master and every extension implementing `taskmaster-cooperative-v2` are equal FIFO peers outside a declared handoff. Neither participant may preempt, cancel, replace, replay, or overwrite the other participant's admitted browser action. During a Task-owned handoff, the runtime state machine admits exactly the declared Task-trigger/extension/verification sequence; this is workflow ordering, not permission priority.
- **PACK-EXT-02 — grant before action:** a cooperative extension requests a lease before every page-changing critical section and waits for an `ok` grant carrying the same `participantId` and `requestId`. It validates that lease, performs its own bounded action with its normal Chrome-granted capabilities, and releases the lease only after the action settles. A rejected, expired, released, or navigation-invalidated lease grants no permission to act or replay. The coordinator schedules ownership only: it does not reduce extension permissions, filter extension APIs, rewrite extension input, or substitute a system action for the extension action.
- **PACK-EXT-03 — runtime-owned coordination:** a Pack routes every visible page change through `journey` and never sends, listens for, or forges extension-coordination events; calls the private bridge; invents another mutex; calls raw Playwright mutation APIs; or starts a nested action. The runtime synchronously reserves both the Task completion ticket and shared Task/extension FIFO position at API admission, before a Task can wait on pause or its private queue, and holds the Task Master lease through the action, transition proof, and settling before it signals the next participant.
- **PACK-EXT-04 — preserve extension capability:** a Pack must not install, disable, uninstall, reconfigure, inspect, or copy an extension or its storage; must not change browser launch flags; and must not treat extension state as task input or output. The Owner's Profile policy controls whether already-installed extensions load. Coordination adds ordering only and does not promise that every extension is compatible with automated Chromium.
- **PACK-EXT-05 — honest unintegrated boundary:** an arbitrary third-party extension that does not implement the cooperative protocol remains fully usable, but no browser API can force its private code into Task Master's FIFO. Before such an extension is operated, pause the task and wait for the durable `paused` state; `waiting_user` is not equivalent to `paused`. Perform the extension action, then resume the same task so the page is revalidated. Never claim unattended serialization for an unintegrated extension.
- **PACK-EXT-06 — Task-owned handoff plan:** when a workflow needs a cooperative extension, the Pack defines the exact handoff point, one bounded `participantId + requestId + operation` triple, one visible Task trigger, the expected postcondition, and the failure path. The Pack must register the exact expectation through `extensionFlow.expectCompletion(...)` while the queue is idle and before the trigger. The runtime arms that single handoff, binds the next Task lease as its trigger, waits for the trigger's action, transition proof, and settling, then starts the bounded completion timer and admits only the matching extension request. Trigger duration is governed by the Journey action timeout rather than consuming the extension's response window. A missing or invalid operation, request/grant before expectation, extension action before trigger, overlapping expectation, extra Task action, or wrong triple poisons the handoff before it can change the page. A timer, focus change, DOM guess, or extension self-report is not a handoff signal.
- **PACK-EXT-07 — proof-gated return:** the extension releases its lease with only a bounded outcome (`status`, machine `code`, and at most 16 machine `facts`). Before the grant is delivered, the runtime durably records the extension effect as started. It validates release against the current holder, derives a receipt from the admitted `participantId + requestId + operation`, and freezes both Task and extension grants. Release or reported outcome alone is not success proof. The Pack awaits the receipt, independently verifies its declared DOM, URL, dialog, download, or other page postcondition through read-only runtime surfaces, then invokes and awaits the extension-dependent checkpoint. The checkpoint call itself—not merely its eventual disk write—must occur after receipt admission; work queued before the receipt can never become proof later. The Worker automatically links that newly admitted checkpoint to the pending receipt; `extensionFlow.resolveCompletion(receiptId, { decision: 'verified', code })` is rejected until this post-receipt checkpoint succeeds, and only that resolution closes the durable effect record. If verification, checkpointing, or the Worker fails after the extension acted, resume exposes an unresolved effect and blocks every new browser mutation until the Pack explicitly verifies and resolves it; blind replay is impossible. Only verified resolution lets the next `journey` or cooperative extension action start. `not_applied`, `unknown`, identity mismatch, missing proof, missing checkpoint, or timeout must be rejected or enter an explicit Owner handoff; it must never be replayed, overwritten, or followed by another page-changing action.
- **PACK-EXT-08 — lifecycle seal:** every Pack awaits `progress(...)`, `handoff.request(...)`, `cooldown(...)`, checkpoint/read, capture, Journey, and extension-flow work at the point it is invoked; none may be detached or scheduled after `run()` returns. Completion synchronously seals all lifecycle and browser-action ingress, drains only work already admitted, and rejects an active unawaited handoff or cooldown. Manager state is monotonic after cancellation or completion claim. The Worker snapshots the complete output tree immediately before that claim, and Manager compares the exact snapshot again after Worker exit. A late callback may neither restore `running`/`waiting_user`/`cooling_down` nor add, remove, rename, or rewrite output.

The complete system-to-extension-to-system state machine is therefore: idle; arm the exact expectation; admit and settle one Task trigger; wait for only the matching extension request; durably record its started effect and only then grant it; let the extension act and release; freeze the queue at its holder-derived receipt; verify real page state; persist the automatically receipt-linked checkpoint; resolve the receipt and durable effect; return to idle; then and only then admit the next action. Pause is part of the same boundary: an active or already-admitted extension lease prevents the runtime from reporting `paused`; an awaiting handoff may pause with its response timer frozen, and no extension grant is delivered until validated resume. The Task Pack owns the workflow-specific trigger, postcondition, failure/handoff decision, and sequence. The runtime owns admission, phase transitions, holder identity, time bounds, pause/resume ordering, checkpoint ordering, queue freezing, durable unknown effects, and fail-closed errors. Neither side gains permission priority over the other.

A Pack that depends on an extension for unattended work declares that operational dependency in its own Skill and pilot instructions, verifies the cooperative handshake before scale, and stops or requests an Owner handoff when the handshake is unavailable. The receipt never contains cookies, tokens, headers, HTML, arbitrary text, or extension storage. The DOM bridge is cooperative coordination, not extension authentication. The Pack must not blindly restore, duplicate, or overwrite an extension action, and it never weakens the base queue to keep going.

The base release gate proves both directions of ordinary ownership (extension first and Task Master first), 500 seeded mixed-arrival rounds, long-action and long-pause queue preservation, pause/resume with Task work ahead of an extension, completion drain for pre-seal actions, Task bursts beyond the external extension queue guard, strict FIFO for concurrent Task actions, participant-scoped request IDs, iframe and navigation release, duplicate suppression, stale-lease fail-closed behavior, request-before-expect and expect-before-trigger rejection, all three triple-mismatch cases, holder-derived completion receipts, pause during awaiting and active extension phases, queue freeze until Task verification, checkpoint-admission ordering, crash/resume replay prevention through the effect journal, cancellation-safe effect resolution, representative Chrome `storage`/`tabs`/`scripting`/host-permission access, and real MV3 execution. A Pack does not recreate those tests. If it depends on extension-produced state, its own bounded pilot additionally proves its exact trigger, triple, page postcondition, checkpoint contents, and rejected/unknown path.

Compatibility and installation rules:

- one Pack contains 1–64 regular `.mjs` files below its own directory and must declare `full-human-v1`;
- names are unique lowercase identifiers and Pack versions use semantic versioning;
- modules are statically checked for direct browser-action bypasses and direct Playwright package imports, then snapshotted and inspected in short-lived child processes before registration;
- the complete batch is validated before the registry changes; any conflict rejects all modules;
- reinstallation of the same name and source hash is idempotent, and installing that identical standalone type through a Pack safely attaches its Pack provenance;
- Pack provenance appears in task-type discovery.

Do not overwrite a registered task type with divergent source. Install a new versioned name, verify it, then run `task-types deprecate OLD_TYPE --replacement NEW_TYPE`. Ordinary discovery exposes only active types and execution of a deprecated type fails with its replacement hint. Use `task-types restore OLD_TYPE` only for an explicit rollback; immutable snapshots remain auditable throughout.

Task modules are trusted code, not an untrusted-code sandbox. Install only reviewed local Packs. The observation facade enforces page-mutation/FIFO discipline; it is not a filesystem or credential sandbox for trusted Node.js modules.

Task Master does not price, authorize, meter, or reimburse external providers. If a specialized workflow can incur charges, its own reviewed Pack and Skill must define provider authorization, an explicit business budget, idempotency, receipts, and stop conditions outside the base runtime. Keep provider credentials out of task input, progress, evidence, and public errors. The base project deliberately supplies no generic paid-call facade: a partial accounting abstraction cannot guarantee what a third-party provider actually bills.

## Composition boundary

- **Base Task Master** owns Manager and browser startup, Profile leasing and behavior, queues, progress and cooldown transport, diagnostics and visual fallback, checkpoint storage and resume, artifact publication, completion gating, and cleanup.
- **Task Pack** owns executable site logic: selectors, navigation, pagination, expansion, parsing, deduplication, platform rate limits, checkpoint fields, stable output files, and completion evidence.
- **Specialized Skill** owns when the capability applies, task-type selection, bounded input mapping, business policy and coverage meaning, result interpretation, and composition with other Skills. It calls the registered task type and does not duplicate Pack code or base runtime machinery.

The specialized Skill should search compact task summaries by domain and intent, describe the selected task type, then use it through MCP. It must not expose module paths or tell the Agent to recreate Manager, Playwright launch, Profile leasing, screenshot fallback, or task-follow logic.

For one truly disposable workflow, a single-file task is enough. Use a Task Pack when two or more task types share a domain, when the workflow will be distributed, or when versioned installation matters.
