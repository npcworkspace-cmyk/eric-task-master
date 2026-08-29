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
  journey, cooldown, effects, semantic, handoff,
  progress, checkpoint, signal
}) {
  const target = new URL(input.url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('url must use HTTP(S)');
  await mkdir(outputDir, { recursive: true });

  await journey.open(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await progress({ current: 1, total: 2, message: 'Target loaded' });
  const data = await page.locator('body').evaluate((body) => ({
    title: document.title.slice(0, 500),
    url: location.href,
    text: (body.innerText || body.textContent || '').slice(0, 20_000)
  }));

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

- The base `action` facade and the stricter Task Pack `journey` facade both use the same complete visible mechanics in `fast`, `auto`, and `human`; only Profile-controlled timing and guard depth change. Task Packs must declare `full-human-v1` and use `journey.open/click/fill/type/hover/scroll/survey/read/select/upload/navigate/nextPage/back`. The Pack specifies sequence, platform rate limits, checkpoints, and business logic; the runtime supplies the physical interaction mechanics and live pacing.
- In a contracted Pack, `page`, `context`, locators, and `semantic` remain available for unpaced deterministic reads, assertions, and bulk extraction, but their mutating methods are blocked. One `evaluate` callback may quickly return many DOM records. Reading `node.value`, `textContent`, attributes, or page structure is valid; assigning `node.value`, clicking, dispatching, or scrolling inside that callback is a contract violation and causes completion to fail even if module code catches the first exception. The legacy `action` mutation surface is unavailable.
- Use `journey.nextPage(locator)` for visible pagination and `journey.navigate(locator)` for visible drill-down. Do not replace site controls with constructed destination URLs during a normal in-page journey. `journey.open` is for initial or independent work-item entries and explicit checkpoint recovery.
- After observing content that the workflow actually reads, call `await journey.read({ words: observedWordCount })`. Do not add custom pointer timing, typing cadence, or scroll-shape code.
- Successful contracted tasks publish `interaction-audit.json` automatically. Its ten checks cover entry, viewport observation, visible target acquisition, pointer/click mechanics, typing cadence when used, continuous wheel-frame density and survey reversal, verified pagination, bypass absence, and settled journey steps. A failed audit rejects completion.
- Report progress after each meaningful, externally verifiable unit. Automatic heartbeat does not replace task progress. By default, two minutes without meaningful progress marks the task `stalled` and captures diagnostics; ten minutes of continued silence fails and cleans it up. `waiting_user` and an explicit `cooling_down` period are not treated as stalls.
- Within one attempt, `current` cannot decrease and a declared finite `total` cannot shrink or disappear. If a finite total was declared, completion requires `current === total`.
- Checkpoint after a recoverable unit. `await checkpoint(data)` stores that bounded data; `await checkpoint.read()` returns exactly the previously stored `data` object, or `null` when no checkpoint exists. It does not return an internal `{ savedAt, data }` wrapper. The complete checkpoint envelope is capped at 8 MiB; store bulk rows/files under `outputDir` and checkpoint only cursors, stable keys, counts, and file references.
- A resume reruns `run(runtime)` in a new isolated Worker and browser context while preserving the same task ID, input, output directory, and checkpoint. Manager verifies and freezes one attempt-scoped checkpoint snapshot. The first executable boundary of a resumed module must be `const previous = await checkpoint.read()`. Until that read succeeds, the runtime rejects every browser `action`, `checkpoint(data)`, and `effects.resolveUnknown(...)`; `effects.pending()` remains observation-only. Branch from fields such as `previous?.nextIndex`; do not assume in-memory variables from the previous attempt still exist.
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

Returning from `run` is only a completion claim. Manager verifies the result shape, every declared Agent-visible artifact, browser closure, Worker exit, and Profile lease release before publishing `completed`. Missing or unstable declared output becomes `TASK_COMPLETION_GATE_FAILED`.
