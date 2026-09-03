# Architecture

Eric Task Master 3.0 is a trusted local task runner, not a browser-policy engine.

## Fixed product path

```text
Agent -> taskmaster CLI -> loopback Manager -> Worker -> stable local Chrome
Human -> fixed Dashboard -> same Manager
```

The CLI is the only Agent integration. There is no MCP adapter, browser extension, Task Type registry, Pack asset catalog, behavior engine, mandatory probe, or special challenge workflow.

## Components

- **CLI:** auto-starts Manager, submits one local `.mjs`, follows progress, and controls tasks and Profiles.
- **Manager:** owns durable state, HTTP Dashboard/API, queues, leases, Worker processes, cleanup, and task output metadata.
- **Worker:** opens the selected persistent Profile with stable local Chrome, imports the copied task script, and exposes direct Playwright objects.
- **Dashboard:** two views only: Tasks and Profiles.
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

## Profiles and concurrency

Every Profile is a Task Master-owned persistent Chrome user-data directory. One Profile is the default.

- one browser writer per Profile;
- different Profiles may run concurrently;
- a task may parallelize stable DOM reads, pages, HTTP, and local processing;
- Manager does not serialize code inside a task;
- heartbeat, process liveness, nonce, and lease generation recover stale leases.

## Waiting and recovery

`wait()` is generic. Manager does not interpret why the task waits. A waiting task keeps its Worker and Profile until the Agent resumes, stops, or deletes it. If the Worker dies, its lease is reclaimed automatically. Scripts that need restartable recovery persist their own checkpoint files under `outputDir`.

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
