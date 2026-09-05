---
name: eric-task-master
description: Run durable local Chrome automation with the installed Task Master CLI. Use when an Agent needs to create and execute a one-off browser task, follow its progress, or manage its Chrome Profile.
---

# Eric Task Master

Use the installed or extracted portable `taskmaster` launcher. For a normal request, do not inspect the project source or create another controller.

## Run the task

1. Write the smallest useful `.mjs` task for the request. Do not register or install it.
2. Start it once. `run` starts Manager automatically and uses the default Profile:

   ```text
   taskmaster run ./job.mjs --input '@input.json' --detach --json
   ```

3. Retain the returned task ID, run `taskmaster panel --json`, and immediately give the user its Dashboard URL.
4. Follow it with `taskmaster follow TASK_ID --json`; optionally add `--wait-ms 30000` to bound a call. Retain `after` and continue with `--after SEQUENCE`. Report meaningful processed counts during a long run.
5. Read the output files and deliver every usable result, including partial results from a stopped or failed run.

Use `--profile NAME_OR_ID` only when the user names a Profile. Do not add a preflight check to a normal task. If `taskmaster` is not on PATH, use its known portable location or the installed launcher directly: Windows `%LOCALAPPDATA%\Programs\Eric Task Master\bin\taskmaster.cmd`; macOS `/usr/local/bin/taskmaster`; Linux `/usr/bin/taskmaster`. If Manager reports `DEFAULT_PROFILE_REQUIRED`, ask the user to create or choose a Profile in `taskmaster panel`; do not install another controller.

For deployment when no launcher is available, use the [latest Release](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest). If the installer fails, download its `eric-task-master-v<VERSION>-<TARGET>-portable.zip`: TARGET is `windows-x64`, `macos-arm64`, `macos-x64`, `linux-arm64`, or `linux-x64`, matching this computer. Verify `SHA256SUMS`, extract to a permanent folder, and use the absolute `eric-task-master/bin/taskmaster.cmd` (Windows) or `eric-task-master/bin/taskmaster` (macOS/Linux) path for every command. It bundles Node.js and Playwright; only stable Chrome must already be installed. The separate Skill ZIP is instructions, not the Manager. OS security approval may still be required; ZIP does not bypass it.

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

Only the entry `.mjs` is copied and frozen. Keep it self-contained: use Node built-ins, bare `playwright`, task `input`, absolute paths, or `outputDir`. Relative sibling imports/files are not copied. For uncertain submission retries, optionally use `run --request-key KEY` (1-160 ASCII letters/digits/`._:-`, starting with a letter/digit): identical submissions return the same task; changed content requires a new key.

If an action with an external effect has an unknown outcome, inspect the page or service before repeating it. Never put cookies, tokens, passwords, or authorization headers in progress messages or output files.

## Verification waits

When the task detects a verification page, stop dispatching work and call `await wait({ reason: 'verification' })`. If it is in another tab, pass `page: thatPage`. Detection belongs to the task; Manager does not intercept arbitrary raw scripts. Do not add a screenshot timer to the task.

Manager retains Chrome, Worker and heartbeat, freezes execution timeout, and requests a system notification immediately and every 30 seconds until actual resume or the 20-minute deadline. Page screenshots occur at 5/10/15/20 minutes. Before the deadline, `follow` returns screenshot `attention` and an `after` cursor. Open `attention.screenshotPath`; only if clearly recovered, run `taskmaster resume TASK_ID --probe PROBE_ID --json` with `attention.probeId`. Otherwise continue following with `--after SEQUENCE`; uncertainty means stay waiting.

At 20 minutes Manager automatically pauses and stops reminders, preserving the browser and checkpoint. `follow` returns `manualResumeRequired`; the final screenshot is diagnostic only and must not trigger probe-based resume. The Dashboard Resume button or user's resume request maps to `taskmaster resume TASK_ID --json`. `stop`/`delete` cancel reminders and end the task. Keep following before automatic pause: CLI cannot wake an Agent whose turn or terminal session ended. Notification presentation follows OS settings; failures never block task control.

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

For manual sign-in, open the Profile in the Dashboard or with `taskmaster profiles open NAME_OR_ID`: this is native Chrome without a debugging connection. Close all its windows before starting a task. Automation reuses that same Profile; individual sites can still require verification again.
