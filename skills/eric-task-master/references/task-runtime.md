# Task runtime

## Commands

Run commands through `scripts/taskmaster.mjs` inside this Skill:

```bash
node scripts/taskmaster.mjs connect --json
node scripts/taskmaster.mjs profiles list --json
node scripts/taskmaster.mjs profiles create --name "Research" --behavior adaptive --json
node scripts/taskmaster.mjs task run --profile PROFILE_ID --module ABSOLUTE_MODULE_PATH --input '{"url":"https://example.com"}' --json
node scripts/taskmaster.mjs task status TASK_ID --json
node scripts/taskmaster.mjs task follow TASK_ID --json
node scripts/taskmaster.mjs task cancel TASK_ID --json
```

Use absolute task-module paths. `task follow` owns progress waiting; do not create a separate polling script.

## Module contract

```js
export const meta = { name: 'short-task-name', version: 1 };

export async function run(runtime) {
  const { page, context, input, outputDir, action, progress, checkpoint } = runtime;
  await page.goto(input.url, { waitUntil: 'domcontentloaded' });
  await progress({ current: 1, total: 1, message: 'Target loaded' });
  return {
    summary: 'Loaded one target',
    evidence: [{ kind: 'url', value: page.url() }]
  };
}
```

`action` applies the selected `fast`, `human`, or `adaptive` policy to click, type, hover, and scroll operations. Direct Playwright locators remain available for deterministic operations.

Persist JSONL, CSV, screenshots, downloads, and other large artifacts under `outputDir`. Returning a large object does not stream or persist it automatically.

Call `progress` at meaningful milestones; the controller supplies heartbeat updates between milestones. Use `checkpoint` after a recoverable unit of work so a specialized module can resume rather than restart.

Task modules must not:

- launch another browser or reuse another profile directory;
- close the supplied context directly;
- log authentication material;
- conceal external writes or claim success without evidence;
- implement their own controller daemon, tab binding, or task-follow loop.

## Outcome handling

When an action times out or its result is unclear, inspect the current page and diagnostic screenshot before retrying. The runtime normalizes the failure and preserves its task ID. Follow or resume that task; do not launch an identical replacement unless the prior task is terminal.
