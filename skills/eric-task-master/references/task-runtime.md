# Task runtime

Read this reference only when an installed high-level task type does not cover the requested work.

## Fixed CLI fallback

```bash
node scripts/taskmaster.mjs task-types list --json
node scripts/taskmaster.mjs task-types install --type TASK_TYPE --module MODULE.mjs --json
node scripts/taskmaster.mjs task run --profile PROFILE_ID --type TASK_TYPE --module MODULE.mjs --input '{"url":"https://example.com"}' --request-key UNIQUE_KEY --json
node scripts/taskmaster.mjs task status TASK_ID --json
node scripts/taskmaster.mjs task follow TASK_ID --json
node scripts/taskmaster.mjs task resume TASK_ID --resume-key STABLE_KEY --json
node scripts/taskmaster.mjs artifacts list TASK_ID --json
node scripts/taskmaster.mjs artifacts read TASK_ID --artifact ARTIFACT_ID --json
node scripts/taskmaster.mjs task cancel TASK_ID --json
```

`task run` follows progress until cleanup settles unless `--detach` is set. The module may live outside the repository: the CLI accepts only a regular single-file `.mjs` of at most 2 MiB, copies it into a Manager-owned inbox, verifies its hash, and snapshots it. Imports of sibling files are therefore not portable; bundle needed logic into the one module.

Installation inspects the snapshot in a short-lived child process and never imports task code into Manager. A top-level exit, exception, or wait fails installation without stopping Manager. This is a stability boundary, not a security sandbox: install only trusted local task code. Reinstalling the same name and SHA is idempotent; using an existing name for different source returns `409 TASK_TYPE_CONFLICT`, so choose a new task-type name for a distinct workflow revision.

## Copyable contract

```js
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const meta = {
  name: 'example-read',
  version: '1.0.0',
  description: 'Read one bounded page.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', minLength: 8, maxLength: 4096 }
    }
  }
};

export async function run({ page, input, outputDir, action, cooldown, effects, progress, checkpoint, signal }) {
  const target = new URL(input.url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('url must use HTTP(S)');
  await mkdir(outputDir, { recursive: true });

  await action.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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

The supported `inputSchema` subset is deliberately small and enforced at registration and task creation: `type`, `enum`, object `properties`/`required`/`additionalProperties`, array `items` and item limits, string length/pattern limits, and numeric minimum/maximum. Unsupported schema keywords fail registration instead of being silently ignored.

## Runtime rules

- Use `action.goto/click/fill/type/hover/scroll/run` so the selected `fast`, `human`, or `adaptive` policy applies. Direct Playwright locators remain available for deterministic reads and assertions.
- Report progress after each meaningful, externally verifiable unit. Automatic heartbeat does not replace task progress.
- Checkpoint after a recoverable unit. `await checkpoint(data)` stores that bounded data; `await checkpoint.read()` returns exactly the previously stored `data` object, or `null` when no checkpoint exists. It does not return an internal `{ savedAt, data }` wrapper.
- A resume reruns `run(runtime)` in a new isolated Worker and browser context while preserving the same task ID, input, output directory, and checkpoint. Start with `const previous = await checkpoint.read()` and branch from fields such as `previous?.nextIndex`; do not assume in-memory variables from the previous attempt still exist.
- Make output writes idempotent with the checkpoint. For append-style results, use a deterministic per-unit filename or stable record key and rebuild the final JSONL/CSV in sorted order. A crash can happen between writing output and saving the next checkpoint, so blind `appendFile()` may duplicate the last unit after resume.
- Inspect current page state and diagnostic evidence before retrying an unknown action outcome. Do not blindly replay writes.
- On 429 or a site-provided cooldown, checkpoint first, then call `await cooldown({ response, attempt, fallbackMs, reason })`. It honors `Retry-After`, applies bounded exponential fallback with positive jitter, switches task state to `cooling_down`, keeps heartbeats visible, and returns to `running` without replaying an action. Platform-specific retry limits remain in the specialized module.
- Check `signal.aborted` inside long loops and stop cleanly.
- Persist large results below `outputDir`, but expose only explicit relative files as `{ kind: 'artifact', file, agentVisible: true }`.
- Agent-visible artifact chunks are returned byte-for-byte so JSON/JSONL/CSV and SHA-256 verification remain valid. Treat `agentVisible: true` as an explicit disclosure decision: never declare a credential-bearing file.
- Keep output bounded. The Worker enforces a default 512 MiB / 10,000-file task budget and preserves existing files on `TASK_OUTPUT_BUDGET_EXCEEDED`; split genuinely larger jobs into checkpointed tasks instead of bypassing the limit.
- Put every state-changing browser operation through `action`; direct `page` access is for observation. Browser effects made through `action` are journaled without selectors, values, or URLs. A Playwright exception is treated as an unknown outcome, never proof that the website did nothing. At the start of a resumed attempt, call `effects.pending()`. If it is non-empty, inspect current page/server state without issuing another external action. Only after verification may the module call `await effects.resolveUnknown(sequence, 'observed_succeeded')` or `await effects.resolveUnknown(sequence, 'observed_not_applied')`. Until then every new `action` is rejected with `TASK_EFFECT_OUTCOME_UNKNOWN`; the journal is evidence, never permission to replay an action.
- Keep returned `summary` and `evidence` compact; returned business arrays are not persisted automatically.
- Do not launch a second browser, reuse another Profile directory, close the supplied context, create another daemon, or implement a parallel task-follow loop.
- Never log credentials or include them in evidence, checkpoints, artifacts, filenames, URLs, or errors.

Task windows close during cleanup even when the module fails. A Manager restart marks interrupted work failed with its checkpoint preserved; it does not guess that an unknown external action is safe to replay. Resume only after cleanup settles, with one stable resume key for that explicit attempt.

Returning from `run` is only a completion claim. Manager verifies the result shape, every declared Agent-visible artifact, browser closure, Worker exit, and Profile lease release before publishing `completed`. Missing or unstable declared output becomes `TASK_COMPLETION_GATE_FAILED`.
