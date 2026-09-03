---
name: eric-task-master
description: Run durable local Chrome automation with the installed Task Master CLI. Use when an Agent needs to create and execute a one-off browser task, follow its progress, or manage its Chrome Profile.
---

# Eric Task Master

Use the installed `taskmaster` command. For a normal request, do not inspect the project source or create another controller.

## Run the task

1. Write the smallest useful `.mjs` task for the request. Do not register or install it.
2. Start it once. `run` starts Manager automatically and uses the default Profile:

   ```text
   taskmaster run ./job.mjs --input '@input.json' --detach --json
   ```

3. Retain the returned task ID, run `taskmaster panel --json`, and immediately give the user its Dashboard URL.
4. Follow it with `taskmaster follow TASK_ID --json`. Report meaningful processed counts during a long run.
5. Read the output files and deliver every usable result, including partial results from a stopped or failed run.

Use `--profile NAME_OR_ID` only when the user names a Profile. Do not add a preflight check to a normal task. If `taskmaster` is missing, tell the user to install Eric Task Master Manager. If Manager reports `DEFAULT_PROFILE_REQUIRED`, ask the user to create or choose a Profile in `taskmaster panel`; do not install another controller.

## Minimal task module

```js
export async function run({ page, context, input, outputDir, progress, wait, signal }) {
  await page.goto(input.url, { waitUntil: 'domcontentloaded' });
  // Use Playwright, page.evaluate(), CDP, HTTP, and local files as the task needs.
  await progress({ current: 1, total: 1, message: 'Done' });
  return { processed: 1 };
}
```

The `page` and `context` values are normal Playwright objects. The task decides navigation, selectors, concurrency, retry, pacing, waiting, recovery, and result format. Write valuable output incrementally under `outputDir`; do not wait until the end to persist a large batch. Use `progress()` after meaningful units. Use generic `wait()` only when this task chooses to pause.

Only the entry `.mjs` is copied and frozen. Keep it self-contained: use Node built-ins, bare `playwright`, task `input`, absolute paths, or `outputDir`. Do not rely on relative sibling imports or files beside the source module because they are not copied.

If an action with an external effect has an unknown outcome, inspect the page or service before repeating it. Never put cookies, tokens, passwords, or authorization headers in progress messages or output files.

## Control

```text
taskmaster status TASK_ID --json
taskmaster follow TASK_ID --json
taskmaster stop TASK_ID --json
taskmaster resume TASK_ID --json
taskmaster delete TASK_ID --json
taskmaster panel
```

Manager owns browser startup, one-writer Profile leases, process cleanup, and task persistence. The task module owns the work.
