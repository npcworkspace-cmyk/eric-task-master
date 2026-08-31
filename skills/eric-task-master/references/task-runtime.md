# Task runtime

Read this reference only when an installed high-level task type does not cover the requested work.

Before writing from scratch, enforce the probe-before-scale gate in [task-packs.md](task-packs.md): when no specialized Skill or registered type covers a large request, use MCP `taskmaster_scale_prepare` or CLI `task prepare-scale` on one representative URL. The runtime dispatches the built-in `surface-probe`; do not recreate its module or parameter contract. Read `surface-probe.json` and pass one bounded pilot before scale. Then follow the concise naming, input, output, and ownership conventions, scaffold the closest production recipe with `task-packs scaffold --recipe single-page|paginated-list|list-detail|resumable-batch|form-workflow`, and run `task-packs validate`. The recipes already encode result persistence, progress, checkpoint, evidence, and lifecycle conventions. Customize site and business logic only; do not fork the runtime contract into a one-off controller.

## Trusted local task-type authoring path

This is not the ordinary `needs_adapter` Agent loop. Use the registered-only
`task start` flow in `SKILL.md` whenever an installed task type covers the
request. Continue here only when trusted local code must be authored and
registered. Module installation is a local administrator surface, not a
sandbox for untrusted code.

Choose one stable CLI Agent identity for the host and reuse it on discovery,
submission, status, recovery, and artifact reads. The Agent identity must never
be a task name; supply the action + object + scope separately with `--label`:

```bash
node scripts/taskmaster.mjs task-types list --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task-types install --type TASK_TYPE --module MODULE.mjs --note "PURPOSE" --json
node scripts/taskmaster.mjs task run --profile PROFILE_ID --type TASK_TYPE --module MODULE.mjs --label TASK_LABEL --input @INPUT_FILE.json --request-key UNIQUE_KEY --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task status TASK_ID --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task follow TASK_ID --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task resume TASK_ID --resume-key STABLE_KEY --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs artifacts list TASK_ID --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs artifacts read TASK_ID --artifact ARTIFACT_ID --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task cancel TASK_ID --agent-id STABLE_ID --agent-name AGENT_NAME --json
```

Put the bounded task input object in `INPUT_FILE.json`. The `@FILE` form is the portable default because it avoids shell-specific JSON quoting; inline JSON remains available for controlled environments.

`task run` follows progress until cleanup settles unless `--detach` is set. The module may live outside the repository: the CLI accepts only a regular single-file `.mjs` of at most 2 MiB, copies it into a Manager-owned inbox, verifies its hash, and snapshots it. Imports of sibling files are therefore not portable; bundle needed logic into the one module.

CLI-installed standalone modules are transient by default. After the first terminal task has confirmed cleanup, the module retires from ordinary Agent discovery and remains recoverable for seven days before guarded cleanup. Add `--persistent` only when a standalone module is intentionally reusable; use a versioned Task Pack for production capability. The Owner Console Task Packs view shows purpose, notes, usage, discovery and lifecycle state, and protects system, live, cleanup-unsettled, or resumable assets from deletion.

Installation inspects the snapshot in a short-lived child process and never imports task code into Manager. A top-level exit, exception, or wait fails installation without stopping Manager. This is a stability boundary, not a security sandbox: install only trusted local task code. Reinstalling the same name and SHA is idempotent; using an existing name for different source returns `409 TASK_TYPE_CONFLICT`, so choose a new task-type name for a distinct workflow revision.

## Copyable contract

```js
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const meta = {
  name: 'example-read',
  version: '1.0.0',
  description: 'Read one bounded page.',
  interactionContract: 'full-human-v1',
  supportsResume: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', minLength: 8, maxLength: 4096 }
    }
  }
};

export async function run({
  page, context, input, outputDir,
  journey, cooldown, effects, semantic, capture, extensionFlow, handoff,
  progress, checkpoint, failure, signal
}) {
  const target = new URL(input.url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('url must use HTTP(S)');
  await mkdir(outputDir, { recursive: true });

  await journey.open(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await progress({ current: 1, total: 2, message: 'Target loaded' });
  const body = page.locator('body');
  const text = await body.innerText().catch(async () => await body.textContent() || '');
  const data = {
    title: (await page.title()).slice(0, 500),
    url: page.url(),
    text: text.slice(0, 20_000)
  };

  const file = 'result.json';
  await writeFile(path.join(outputDir, file), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await checkpoint({ stage: 'persisted', url: data.url, artifact: file });
  await progress({ current: 2, total: 2, message: 'Result persisted' });
  return {
    summary: `Captured ${data.text.length} characters`,
    evidence: [
      { kind: 'url', value: data.url },
      { kind: 'artifact', file, agentVisible: true }
    ]
  };
}
```

The module return value is not streamed. Persist large or durable data below `outputDir`, declare each safe relative file as an Agent-visible artifact, and return only a compact summary/evidence object. Unlisted files remain internal.

The completion claim must contain a non-empty `summary` of at most 4,000 characters and 1-32 evidence items. A `full-human-v1` module may return at most 31 because the runtime reserves one item for its generated interaction audit. Supported evidence shapes are:

- `{ kind: 'url', value: 'https://...' }` for one HTTP(S) URL;
- `{ kind: 'count', value: 123 }` for a non-negative finite count;
- `{ kind: 'hash', value: '...' }` for 32-128 hexadecimal characters;
- `{ kind: 'message' | 'note', value: '...' }` for bounded non-empty text;
- `{ kind: 'artifact', file: 'relative/output.json', agentVisible: true }` for a regular file below `outputDir`.

An optional non-empty `label` may be at most 128 characters. Manager hashes and size-anchors every declared artifact before publishing the result. A result and its result artifacts are not Agent-visible until the task reaches verified `completed`; later mutation changes the task to `failed` and blocks artifact access.

When trusted task code can explain a failure safely, use the bounded public failure facade instead of throwing provider text or relying on a generic exception:

```js
failure.raise({
  category: 'precondition',
  code: 'TARGET_NOT_READY',
  publicMessage: 'The requested target is not ready for collection.',
  fields: [
    { path: '$.url', reason: 'The loaded page did not expose the expected public surface.' }
  ],
  nextAction: 'Check the target URL or sign in through the selected persistent Profile, then resume once.'
});
```

Allowed categories are `input`, `precondition`, `provider`, `navigation`, `data`, and `runtime`. Codes are stable uppercase machine identifiers. A public failure may contain at most eight bounded field entries; `expectedType` and `receivedType` are optional. The runtime redacts the contract again before it crosses the Worker boundary. Any arbitrary exception, stack, local path, credential, provider payload, or unsupported shape remains private and is exposed only as a generic task failure.

## Semantic observation and visual fallback

Use ordinary Playwright locators when the workflow already knows the page. Use `semantic` when structure is unfamiliar or a stable ref is cheaper than repeatedly sending page screenshots to an Agent:

```js
const view = await semantic.snapshot({
  scope: 'viewport',       // or 'full_page' for document-wide semantic text
  maxNodes: 180,
  maxTextChars: 12_000
});

const submit = view.refs.find((item) => item.role === 'button' && /submit/i.test(item.name));
if (!submit) {
  const instruction = await handoff.request({
    reason: 'Submit control is not semantically identifiable',
    instructions: 'Inspect the screenshot and semantic observation, then describe the safe next step.',
    timeoutMs: 10 * 60_000
  });
  await progress({ current: 1, total: 2, message: `Instruction received: ${instruction.note || 'continue'}` });
} else {
  await semantic.click(submit.ref, {
    snapshotId: view.id,
    actionOptions: { timeout: 10_000 }
  });
}
```

Available methods are:

- `semantic.snapshot(options)` → `{ id, url, title, content, refs, truncated, frameErrors }`, where `frameErrors` is the numeric count of Frames that could not be observed;
- `semantic.resolve(ref, { snapshotId })` → one exact Playwright Locator;
- `semantic.href(ref, { snapshotId })` → an absolute HTTP(S) URL;
- `semantic.click(ref, { snapshotId, actionOptions })`;
- `semantic.fill(ref, value, { snapshotId, actionOptions })`;
- `semantic.navigate(ref, { snapshotId, navigationOptions })`.

Refs are intentionally invalid after navigation or a newer snapshot. Take a fresh snapshot rather than guessing. Cross-origin frames are inspected through Playwright frame APIs with a bounded frame count; failed frames are reported in `frameErrors` and do not silently become successful observations.

`handoff.request()` captures a viewport screenshot and semantic observation before state becomes `waiting_user`. Manager accepts continuation only for the matching live request ID. The module resumes in the same Worker and must verify current page state before acting. If the request times out, the task fails and cleanup closes the browser.

The supported `inputSchema` subset is deliberately small and enforced at registration and task creation: `type`, `enum`, object `properties`/`required`/`additionalProperties`, array `items` and item limits, string length/pattern limits, and numeric minimum/maximum. Unsupported schema keywords fail registration instead of being silently ignored.

## Runtime rules

- When a persistent Profile has extensions enabled, follow the mandatory extension coexistence contract in [task-packs.md](task-packs.md). Cooperative extensions and Task Master are equal FIFO peers outside a declared handoff: ordinary actions use FIFO arrival order, while a declared handoff uses the runtime-enforced Task-trigger/exact-extension/proof/checkpoint sequence. The Pack keeps every visible mutation inside `journey`, never sends coordination events or creates a competing lock, and observes extension-produced state only after that extension releases its lease. This schedules actions without reducing the extension's Chrome-granted capabilities. An unintegrated extension requires the task to reach durable `paused` before it is operated.

For a Task-owned cooperative handoff, register one exact three-part expectation while the action queue is idle and before the visible trigger. The extension integration must use the same bounded identifiers; use a distinct request ID for every handoff in one task. The runtime binds the next Task Journey lease as the trigger and admits no extension before it settles:

```js
const completion = extensionFlow.expectCompletion({
  participantId: 'catalog-helper',
  requestId: 'catalog-sync-1',
  operation: 'sync-visible-item',
  timeoutMs: 10_000
});

// Task Master keeps this lease until the click, transition proof, and settling
// finish. Only then can the extension receive its matching grant.
await journey.click('#send-to-extension');
const receipt = await completion;

const observed = {
  status: await page.locator('#sync-status').textContent(),
  itemId: await page.locator('#item-id').getAttribute('data-value')
};
const verified =
  receipt.participantId === 'catalog-helper' &&
  receipt.requestId === 'catalog-sync-1' &&
  receipt.operation === 'sync-visible-item' &&
  receipt.outcome.status === 'succeeded' &&
  observed.status === 'Ready' && Boolean(observed.itemId);

if (!verified) {
  await extensionFlow.resolveCompletion(receipt.receiptId, {
    decision: 'rejected',
    code: 'sync-postcondition-mismatch'
  });
}
await checkpoint({ stage: 'extension-sync-verified', observed });
await extensionFlow.resolveCompletion(receipt.receiptId, {
  decision: 'verified',
  code: 'sync-postcondition-verified'
});

// No Task or cooperative extension mutation can start before the verified
// resolution above. The Pack now owns the decision to continue.
await journey.click('#next-item');
```

`extensionFlow.enabled` reports whether this Profile launched with extension coordination, and `extensionFlow.protocol` identifies the cooperative contract. `expectCompletion` is not an extension command: the Pack's declared visible trigger and the extension's matching lease request define the handoff. The runtime rejects request-before-expect, extension-before-trigger, overlapping expectations, an extra Task action while waiting, and a mismatch in any field of `participantId + requestId + operation`. It ignores spoofed identity fields on release and derives the receipt from the admitted holder. The completion timer begins only after the Task trigger has settled, so the trigger uses its own Journey timeout and does not consume the extension response window. Before delivering an extension grant, the Worker durably opens a metadata-only effect record; a grant lost during persistence fails closed without manufacturing a receipt. A bounded extension outcome is an untrusted hint, not proof. Verify actual page state, then call and `await checkpoint(...)` only after receiving the receipt; the Worker freezes receipt identity at checkpoint API admission, so an older queued checkpoint can never become proof merely because it writes later. A `verified` resolution is rejected until that post-receipt checkpoint succeeds. That resolution also closes the durable effect. If the module fails after release but before verified resolution, the next attempt sees `effects.pending()` and every browser mutation remains blocked until the Pack explicitly verifies and calls `effects.resolveUnknown(...)`; never replay the extension action. A `rejected` resolution fails closed; a navigation, frame detach, or page close produces `unknown` and still requires an explicit decision. If no matching completion arrives, the expectation times out and the task's normal failure diagnostics capture the page. During pause, an active extension lease must settle before durable `paused`; a queued extension cannot pre-acquire the pause boundary ahead of earlier Task work, and an awaiting handoff freezes its remaining completion timeout until validated resume. Do not catch these errors to continue with another browser action.
- The base `action` facade and the stricter Task Pack `journey` facade both use the same complete visible mechanics in `fast`, `auto`, and `human`; only Profile-controlled timing and guard depth change. Task Packs must declare `full-human-v1` and use `journey.open/click/fill/type/hover/scroll/survey/read/select/upload/navigate/nextPage/back`. The Pack specifies sequence, platform rate limits, checkpoints, and business logic; the runtime supplies the physical interaction mechanics and live pacing.
- Every task receives a positive read-only `page` and `context` facade for deterministic reads, assertions, and bounded extraction. Use `count`, `nth`, `innerText`, `textContent`, `inputValue`, `getAttribute`, `allTextContents`, and related Playwright reads. A standalone module routes every page mutation through `action`; a contracted Task Pack routes every mutation through the stricter `journey` facade and cannot use `action`. A Pack must not import `playwright` or `playwright-core`; preflight rejects both static and dynamic direct package imports. Arbitrary page/frame/locator/worker/handle `evaluate` and `evaluateAll` are unavailable because aliases and prototype methods cannot be proven read-only. Raw `Locator.screenshot`, `Page.screenshot`, and `Page.pdf` are also unavailable because they can scroll a locator, fast-forward animations, or dispatch print events. Use `await capture.viewport({ file: 'evidence.png' })`; it accepts one new PNG/JPEG basename, captures only the current viewport with animations and caret untouched, writes under `outputDir`, enforces the output budget, and occupies the same Task/extension FIFO as every other runtime action. Before Task import, the Worker binds observation bookkeeping to startup-captured container intrinsics and locks the Playwright client mutation hooks used by runtime actions. These are defense-in-depth controls for reviewed local task code; trusted modules remain Node.js code and are not isolated from the host filesystem, Profile credentials, or deliberate same-realm abuse.
- Use `journey.nextPage(locator)` for visible pagination and `journey.navigate(locator)` for visible drill-down. Do not replace site controls with constructed destination URLs during a normal in-page journey. `journey.open` is for initial or independent work-item entries and explicit checkpoint recovery.
- After observing content that the workflow actually reads, call `await journey.read({ words: observedWordCount })`. Do not add custom pointer timing, typing cadence, or scroll-shape code.
- Successful contracted tasks publish `interaction-audit.json` automatically. Its ten checks cover entry, viewport observation, visible target acquisition, pointer/click mechanics, typing cadence when used, continuous wheel-frame density and survey reversal, verified pagination, bypass absence, and settled journey steps. A failed audit rejects completion.
- Report progress after each meaningful, externally verifiable unit. Automatic heartbeat does not replace task progress. By default, two minutes without meaningful progress marks the task `stalled` and captures diagnostics; ten minutes of continued silence fails and cleans it up. `waiting_user` and an explicit `cooling_down` period are not treated as stalls.
- Within one attempt, `current` cannot decrease and a declared finite `total` cannot shrink or disappear. If a finite total was declared, completion requires `current === total`.
- Checkpoint after a recoverable unit. `await checkpoint(data)` stores the bounded data and extension-proof context frozen at that exact invocation; `await checkpoint.read()` returns exactly the previously stored `data` object, or `null` when no checkpoint exists. It does not return an internal `{ savedAt, data }` wrapper. The complete checkpoint envelope is capped at 8 MiB; store bulk rows/files under `outputDir` and checkpoint only cursors, stable keys, counts, and file references. Never fire-and-forget `progress(...)`, `handoff.request(...)`, `cooldown(...)`, checkpoint/read, or effect/extension resolution work. The runtime synchronously seals these ingress queues when `run()` returns, drains work already admitted, rejects incomplete or late lifecycle work, and prevents cancellation or a delayed callback from publishing a later non-terminal state. No timer may rewrite terminal state or remove an unknown replay barrier.
- A resume reruns `run(runtime)` in a new isolated Worker and browser context while preserving the same task ID, input, output directory, and checkpoint. Manager verifies and freezes one attempt-scoped checkpoint snapshot. The first executable boundary of a resumed module must be `const previous = await checkpoint.read()`. Until that read succeeds, the runtime rejects every Task browser boundary (`action`, `journey`, `capture`, handoff diagnostics, and cooperative extension admission), `checkpoint(data)`, and `effects.resolveUnknown(...)`; `effects.pending()` remains observation-only. Branch from fields such as `previous?.nextIndex`; do not assume in-memory variables from the previous attempt still exist.
- Make output writes idempotent with the checkpoint. For append-style results, use a deterministic per-unit filename or stable record key and rebuild the final JSONL/CSV in sorted order. A crash can happen between writing output and saving the next checkpoint, so blind `appendFile()` may duplicate the last unit after resume.
- Inspect current page state and diagnostic evidence before retrying an unknown action outcome. Do not blindly replay writes.
- Direct initial or independent GET navigation through `action.goto()` has one centrally owned recovery lane: it retries only a bounded set of transient connection failures and 429/502/503/504 responses, honors `Retry-After`, reports `cooling_down`, and stops after the fixed retry budget. Do not wrap it in a second navigation retry loop. For later platform responses or site-defined limits, checkpoint first, then call `await cooldown({ response, attempt, fallbackMs, reason })`. Clicks, form submissions, uploads, downloads, and other potentially mutating actions are never auto-replayed.
- Check `signal.aborted` inside long loops and stop cleanly.
- Persist large results below `outputDir`, but expose only explicit relative files as `{ kind: 'artifact', file, agentVisible: true }`.
- Agent-visible artifact chunks are returned byte-for-byte so JSON/JSONL/CSV and SHA-256 verification remain valid. Treat `agentVisible: true` as an explicit disclosure decision: never declare a credential-bearing file.
- Keep output bounded. The Worker enforces a default 512 MiB / 10,000-file task budget and preserves existing files on `TASK_OUTPUT_BUDGET_EXCEEDED`; split genuinely larger jobs into checkpointed tasks instead of bypassing the limit.
- Put every state-changing browser operation through `journey` in a Task Pack. Browser effects are journaled without selectors, values, or URLs. A Playwright exception is treated as an unknown outcome, never proof that the website did nothing. At the start of a resumed attempt, call `effects.pending()`. If it is non-empty, inspect current page/server state without issuing another external action. Only after verification may the module call `await effects.resolveUnknown(sequence, 'observed_succeeded')` or `await effects.resolveUnknown(sequence, 'observed_not_applied')`. Until then every new journey action is rejected with `TASK_EFFECT_OUTCOME_UNKNOWN`; the journal is evidence, never permission to replay an action.
- Keep returned `summary` and `evidence` compact; returned business arrays are not persisted automatically.
- Do not launch a second browser, reuse another Profile directory, close the supplied context, create another daemon, or implement a parallel task-follow loop.
- Never log credentials or include them in evidence, checkpoints, artifacts, filenames, URLs, or errors.

Task windows close during cleanup even when the module fails. A Manager restart marks interrupted work failed with its checkpoint preserved; it does not guess that an unknown external action is safe to replay. Resume only after cleanup settles, with one stable resume key for that explicit attempt.

The task timeout covers output setup, Playwright import, browser launch, task-module import, and `run()`. Cooperative async stalls are cancelled and cleaned up. Trusted task code must not block the Node event loop with an infinite synchronous loop; if a Worker or operating system is hard-killed, the Manager fails closed and keeps the Profile unavailable unless browser cleanup can be proved.

Returning from `run` initiates, but does not publish, completion. The Worker seals all lifecycle and action ingress, drains admitted work, writes the runtime-owned audit, and takes a bounded content-addressed snapshot of the complete output tree immediately before sending its completion claim. Manager compares that exact snapshot again after Worker exit; added, removed, renamed, or rewritten files or directories fail closed. It also verifies the result shape, every declared Agent-visible artifact, browser closure, and Profile lease release before publishing `completed`. Missing, unstable, linked, or post-claim output becomes `TASK_COMPLETION_GATE_FAILED` or `TASK_OUTPUT_CHANGED_AFTER_COMPLETION`.
