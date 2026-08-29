# Task Packs and specialized Skills

Read this reference when capability should be reusable across tasks or Agents. A Task Pack carries trusted task modules; a specialized Skill teaches an Agent when and how to use them.

## Create and install

```bash
node scripts/taskmaster.mjs task-packs scaffold ./reddit-comments --name reddit-comments --recipe paginated-list --json
node scripts/taskmaster.mjs task-packs validate ./reddit-comments --json
node scripts/taskmaster.mjs task-packs install ./reddit-comments --json
```

Choose exactly one built-in recipe: `single-page`, `paginated-list`, `list-detail`, `resumable-batch`, or `form-workflow`. Each recipe already contains the approved lifecycle, bounded progress, output persistence, completion evidence, cleanup-compatible control flow, checkpoint pattern, and mandatory `full-human-v1` journey contract. Start from the closest recipe instead of rewriting infrastructure. `task-packs validate` performs isolated module preflight without registering anything and reports every detected module error in one pass.

The manifest is named `taskpack.json`:

```json
{
  "name": "reddit-comments",
  "version": "1.0.0",
  "title": "Reddit Comments",
  "description": "One bounded workflow family.",
  "interactionContract": "full-human-v1",
  "tasks": [
    { "name": "reddit-comments.collect.v1", "module": "tasks/collect-v1.mjs" }
  ]
}
```

## Minimal conventions

- Use one lowercase capability slug `<domain>-<capability>`, such as `reddit-comments`. Give the specialized Skill and its Task Pack that same slug; do not append `-skill` or `-eric-task-master-skill`.
- Name a task type `<pack>.<verb>.vN` and its module `tasks/<verb>-vN.mjs`, for example `reddit-comments.collect.v1` and `tasks/collect-v1.mjs`. A task type is immutable after registration. Use `.v2` only when its executable input, output, or meaning becomes incompatible.
- The Pack's semantic version describes the distributed Pack release and is independent of the task type's `.vN`. A Pack may move from `1.0.0` to `1.1.0` while retaining an unchanged `.v1` task type.
- At task start, supply a concise `taskLabel` as action + object + scope, such as `采集-Reddit评论-5帖`. Do not put the Agent name or a timestamp in it; Manager adds stable Agent identity and creation time to the display name.
- Use bounded `camelCase` input fields that describe only business intent. Do not put runtime controls, Profile IDs, behavior modes, Agent IDs, cookies, tokens, or other credentials in task input.
- Keep applicable output names stable within one task type, preferring `result.json`, `records.jsonl`, `summary.json`, and `manifest.json`. A Pack need not emit every file, but it must not rename equivalent outputs between runs.

## Mandatory probe-before-scale gate

When no specialized Skill or registered task type covers a large request, first call MCP `taskmaster_scale_prepare` or CLI `task prepare-scale` against one representative entry URL. The runtime starts the built-in `surface-probe`; task authors do not recreate or vary that probe contract. Large means at least 20 independent pages/items, pagination or recursive expansion, an expected run above ten minutes, or unattended batch execution. Read its declared `surface-probe.json` artifact before authoring the Task Pack. Probe at most three URLs only when the site has materially different list/detail/account surfaces.

The probe is read-only and bounded. It samples headings, links, controls, page length, stable locator hints, pagination candidates, challenge signals, and a central rapid survey/backtrack journey, then recommends the closest recipe. It does not prove full-site coverage, grant permission, or defeat a login, CAPTCHA, press-and-hold challenge, or rate limit. A detected human-verification challenge creates a same-task `human_verification` handoff and waits for the Owner; no solver or bypass is used. After an explicit continuation, the probe observes again. CAPTCHA, rate-limit, unreadable-frame, omitted-frame, and any truncated observation keep `scaleAllowed` false. After the probe, customize the recommended recipe and run one bounded pilot whose result schema, checkpoints, rate policy, and completion evidence pass before raising the scale.

## Mandatory Human Journey contract

Every Task Pack declares `"interactionContract": "full-human-v1"`, and every Pack module declares `meta.interactionContract: 'full-human-v1'`. The Pack defines **what** to do, in what order, platform rate limits, when to checkpoint, and how to prove completion. The base runtime owns **how each visible browser action is physically performed and paced by the Profile's live mode**.

- Use `journey.open` for an entry URL or an explicit recovery entry.
- Use `journey.navigate` and `journey.nextPage` for links, detail pages, and pagination controls. Do not construct the next-page URL when the page exposes a usable Next control.
- Use `journey.click/fill/type/hover/scroll/survey/read/select/upload` for visible actions. On a static page, `journey.survey()` is one continuous downward wheel stream followed by one continuous return stream; its fine wheel events are motion frames rather than separately paused actions. Do not recreate its mechanics in a Pack.
- Use `page`, `context`, locators, `evaluate`, and `semantic` directly for fast reads, assertions, bulk extraction, and observation. These reads are deliberately unpaced: one callback can return an array of DOM records. Reading `node.value` is valid; assigning it, clicking, dispatching, or scrolling from the callback is not. Contracted Packs receive read-only wrappers, and direct mutation fails at runtime even if task code catches the first error.
- Do not accept behavior mode, pointer timing, scroll shape, or typing cadence in Pack input. Those mechanics are centrally owned and versioned.

In `fast`, `auto`, and `human`, the runtime still traverses rendered content with minimum-jerk wheel and pointer acceleration, rapid long-distance approach followed by precision acquisition, visible survey backtracking, in-target clicks, explicit per-character keyboard cadence, bounded reading dwell, verified visible transitions, and an Agent-visible `interaction-audit.json`. `fast` compresses time but keeps a non-zero keyboard cadence and the same motion topology. The selected Profile mode changes speed and caution, not the required journey. Completion fails unless all ten journey checks pass. This is a reliability and consistency contract, not fingerprint spoofing, CAPTCHA bypass, or a guarantee that a website cannot identify automation.

For independent items in a batch, opening each supplied URL is a valid new entry. Within one item, use visible site controls for pagination and drill-down. A direct URL may be used as a checkpoint-recovery entry when the previous rendered page no longer exists; record that recovery in task progress or coverage.

Compatibility and installation rules:

- one Pack contains 1–64 regular `.mjs` files below its own directory and must declare `full-human-v1`;
- names are unique lowercase identifiers and Pack versions use semantic versioning;
- modules are statically checked for direct browser-action bypasses, then snapshotted and inspected in short-lived child processes before registration;
- the complete batch is validated before the registry changes; any conflict rejects all modules;
- reinstallation of the same name and source hash is idempotent, and installing that identical standalone type through a Pack safely attaches its Pack provenance;
- Pack provenance appears in task-type discovery.

Do not overwrite a registered task type with divergent source. Install a new versioned name, verify it, then run `task-types deprecate OLD_TYPE --replacement NEW_TYPE`. Ordinary discovery exposes only active types and execution of a deprecated type fails with its replacement hint. Use `task-types restore OLD_TYPE` only for an explicit rollback; immutable snapshots remain auditable throughout.

Task modules are trusted code, not an untrusted-code sandbox. Install only reviewed local Packs.

For a Pack that calls a paid external API, declare `meta.externalCost = { currency: 'USD', maxAmountPerRun: N }` on every affected task type. Task start must include `externalCostBudget = { currency: 'USD', maxAmount: M }` with `M <= N`; the Worker receives that object frozen together with an `externalCost` facade. Before a paid request, call `const grant = await externalCost.reserve({ operationId, estimatedAmount })` and call the provider only when `grant.execute === true`. An identical concurrent/resume replay receives `execute: false` plus `status: 'reserved'` or `'settled'`; recover its durable result or stop, but never bill it again. Reserve a conservative upper bound: `await externalCost.settle({ operationId, actualAmount })` rejects actual cost above that operation's reservation. Manager serializes requests and persists the task-wide ledger before each acknowledgement, so retries and resume attempts consume the same balance. Changed values, missing reservations, zero reservations, or amounts beyond the task/per-operation limit are rejected. Completion requires no outstanding reservations plus exactly one `{ kind: 'count', label: 'external-cost-estimated', value }` and one `{ kind: 'count', label: 'external-cost-actual', value }` matching the ledger totals. Public task state exposes aggregate usage only. This is a hard gate for reviewed Pack code using the facade, not a firewall around arbitrary provider traffic.

## Composition boundary

- **Base Task Master** owns Manager and browser startup, Profile leasing and behavior, queues, progress and cooldown transport, diagnostics and visual fallback, checkpoint storage and resume, artifact publication, completion gating, and cleanup.
- **Task Pack** owns executable site logic: selectors, navigation, pagination, expansion, parsing, deduplication, platform rate limits, checkpoint fields, stable output files, and completion evidence.
- **Specialized Skill** owns when the capability applies, task-type selection, bounded input mapping, business policy and coverage meaning, result interpretation, and composition with other Skills. It calls the registered task type and does not duplicate Pack code or base runtime machinery.

The specialized Skill should search compact task summaries by domain and intent, describe the selected task type, then use it through MCP. It must not expose module paths or tell the Agent to recreate Manager, Playwright launch, Profile leasing, screenshot fallback, or task-follow logic.

For one truly disposable workflow, a single-file task is enough. Use a Task Pack when two or more task types share a domain, when the workflow will be distributed, or when versioned installation matters.
