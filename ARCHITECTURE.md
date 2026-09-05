# Architecture

Eric Task Master 3 is a trusted local task runner.

## Fixed product path

```text
Agent -> taskmaster CLI -> loopback Manager -> Worker -> stable local Chrome
Human -> fixed Dashboard -> same Manager
```

The CLI is the only Agent integration. There is no MCP adapter, browser extension, Task Type registry, Pack asset catalog, behavior engine, or mandatory preflight probe.

## Components

- **CLI:** auto-starts Manager, submits one local `.mjs`, follows progress, and controls tasks and Profiles.
- **Manager:** owns durable state, HTTP Dashboard/API, queues, leases, Worker processes, cleanup, and task output metadata.
- **Worker:** opens the selected persistent Profile with stable local Chrome, imports the copied task script, and exposes direct Playwright objects.
- **Dashboard:** two views only: current Tasks and Profiles. Terminal tasks disappear from the panel; Manager retains their records and output for CLI follow and explicit cleanup.
- **Skill:** one short, platform-neutral CLI guide.

## Task contract

A task exports `run(ctx)` or a default function. The context contains:

```js
{
  page,
  context,
  browser,
  playwright,
  input,
  outputDir,
  signal,
  progress,
  wait
}
```

Scripts are free to use Playwright, evaluate, CDP, network and filesystem APIs. Manager copies the submitted script into the task directory, records its SHA-256, and executes that frozen copy. It never deletes the Agent's source file.

Current task state is stored atomically, and the Manager retains a bounded event history for progress and diagnostics. Output files are available while the task is running and remain useful after stop or error. A task that needs checkpoints writes them incrementally under `outputDir` and decides how a later task consumes them.

Frequent progress updates coalesce to the latest value once per second; state transitions flush pending progress first. Heartbeats renew the lease without rewriting task history. Output-budget scans share in-flight work and a five-second cache on progress; startup, periodic checks, diagnostics, and completion still enforce the budget directly.

An optional `run --request-key KEY` makes submission retries return the existing task. A key is bound to the frozen module bytes and canonical request parameters; conflicting reuse is rejected. Different keys permit intentional repeats. `follow` drains retained terminal events and returns a cursor; `--wait-ms` optionally bounds one call. A compatible Manager is reused without maintenance on normal commands. Explicit idle maintenance is serialized with task creation and Profile operations.

## Profiles and concurrency

Every Profile is a Task Master-owned persistent Chrome user-data directory. One Profile is the default.

- one browser writer per Profile;
- different Profiles may run concurrently;
- a task may parallelize stable DOM reads, pages, HTTP, and local processing;
- Manager does not serialize code inside a task;
- heartbeat, process liveness, nonce, and lease generation recover stale leases.

## Waiting and recovery

Generic `wait()` retains its Worker and Profile until explicit resume, stop, or delete. A task chooses when verification is present and calls `wait({ reason: 'verification' })`; Manager does not inspect arbitrary pages. Verification waiting freezes execution timeout accounting, retains Chrome, and takes four screenshots at 5/10/15/20 minutes. The Agent may resume against a current screenshot during the first 20 minutes. Resume requires Worker acceptance and the actual resumed transition, bounded by a timeout.

Notifications are an independent side effect: immediately on entering verification waiting, then every 30 seconds while that wait remains active. At 20 minutes, an independent timer marks the wait automatically paused, stops reminders and future automatic decisions, and preserves the browser for manual resume. The fourth screenshot is diagnostic only. Screenshot delays and notification failures cannot extend this deadline or block control commands. Resume requests alone do not stop reminders; actual resume, explicit stop/delete, terminal state, or automatic pause does.

Windows uses current-user WinRT toast registration, macOS uses `osascript`, and Linux uses optional `notify-send`. OS notification settings determine presentation. Helpers run outside the state mutation queue, have bounded execution, and are cancelled with the wait. Scripts that need restartable recovery persist their own checkpoint files under `outputDir`.

Manager never replays an entire failed script automatically. Resume is an explicit Agent or human action.

## Deletion

Delete is always available. The task disappears from the public API immediately. Cleanup then follows a private, durable tombstone:

```text
remove public task -> request stop -> contain owned process tree -> release proven lease -> remove output and tombstone
```

If process death or browser cleanup cannot yet be proved, the private tombstone and Profile lease remain quarantined and the reaper retries. Output is removed only after the old Worker can no longer write. A Manager restart reloads pending tombstones and continues recovery; public deletion never forces an unsafe Profile release.

User-selected output files outside Manager state are not removed.

## Trust boundary

Task scripts are trusted code running as the current OS user. Manager provides no domain or API permission sandbox. Web content remains data: only an Agent-authored local module is imported as executable code.

The Manager binds to loopback, checks same-origin mutations from the Dashboard, protects CLI mutations with a local token, and redacts credentials from Manager-owned logs.
