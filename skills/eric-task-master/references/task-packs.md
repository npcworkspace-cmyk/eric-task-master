# Task Packs and specialized Skills

Read this reference when capability should be reusable across tasks or Agents. A Task Pack carries trusted task modules; a specialized Skill teaches an Agent when and how to use them.

## Create and install

```bash
node scripts/taskmaster.mjs task-packs scaffold ./reddit-comments --name reddit-comments --recipe paginated-list --json
node scripts/taskmaster.mjs task-packs validate ./reddit-comments --json
node scripts/taskmaster.mjs task-packs install ./reddit-comments --json
```

Choose exactly one built-in recipe: `single-page`, `paginated-list`, `list-detail`, `resumable-batch`, or `form-workflow`. Each recipe already contains the approved lifecycle, bounded progress, output persistence, completion evidence, cleanup-compatible control flow, and the checkpoint pattern appropriate to that shape. Start from the closest recipe instead of rewriting infrastructure. `task-packs validate` performs isolated module preflight without registering anything and reports every detected module error in one pass.

The manifest is named `taskpack.json`:

```json
{
  "name": "reddit-comments",
  "version": "1.0.0",
  "title": "Reddit Comments",
  "description": "One bounded workflow family.",
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

Compatibility and installation rules:

- one Pack contains 1–64 regular `.mjs` files below its own directory;
- names are unique lowercase identifiers and Pack versions use semantic versioning;
- modules are snapshotted and inspected in short-lived child processes before registration;
- the complete batch is validated before the registry changes; any conflict rejects all modules;
- reinstallation of the same name and source hash is idempotent, and installing that identical standalone type through a Pack safely attaches its Pack provenance;
- Pack provenance appears in task-type discovery.

Do not overwrite a registered task type with divergent source. Install a new versioned name, verify it, then run `task-types deprecate OLD_TYPE --replacement NEW_TYPE`. Ordinary discovery exposes only active types and execution of a deprecated type fails with its replacement hint. Use `task-types restore OLD_TYPE` only for an explicit rollback; immutable snapshots remain auditable throughout.

Task modules are trusted code, not an untrusted-code sandbox. Install only reviewed local Packs.

## Composition boundary

- **Base Task Master** owns Manager and browser startup, Profile leasing and behavior, queues, progress and cooldown transport, diagnostics and visual fallback, checkpoint storage and resume, artifact publication, completion gating, and cleanup.
- **Task Pack** owns executable site logic: selectors, navigation, pagination, expansion, parsing, deduplication, platform rate limits, checkpoint fields, stable output files, and completion evidence.
- **Specialized Skill** owns when the capability applies, task-type selection, bounded input mapping, business policy and coverage meaning, result interpretation, and composition with other Skills. It calls the registered task type and does not duplicate Pack code or base runtime machinery.

The specialized Skill should search compact task summaries by domain and intent, describe the selected task type, then use it through MCP. It must not expose module paths or tell the Agent to recreate Manager, Playwright launch, Profile leasing, screenshot fallback, or task-follow logic.

For one truly disposable workflow, a single-file task is enough. Use a Task Pack when two or more task types share a domain, when the workflow will be distributed, or when versioned installation matters.
