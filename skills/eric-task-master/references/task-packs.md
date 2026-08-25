# Task Packs and specialized Skills

Read this reference when capability should be reusable across tasks or Agents. A Task Pack carries trusted task modules; a specialized Skill teaches an Agent when and how to use them.

## Create and install

```bash
node scripts/taskmaster.mjs task-packs scaffold ./my-pack --name my-pack --recipe paginated-list --json
node scripts/taskmaster.mjs task-packs validate ./my-pack --json
node scripts/taskmaster.mjs task-packs install ./my-pack --json
```

Choose exactly one built-in recipe: `single-page`, `paginated-list`, `list-detail`, `resumable-batch`, or `form-workflow`. Each recipe already contains the approved lifecycle, bounded progress, output persistence, completion evidence, cleanup-compatible control flow, and the checkpoint pattern appropriate to that shape. Start from the closest recipe instead of rewriting infrastructure. `task-packs validate` performs isolated module preflight without registering anything and reports every detected module error in one pass.

The manifest is named `taskpack.json`:

```json
{
  "name": "my-pack",
  "version": "1.0.0",
  "title": "My Pack",
  "description": "One bounded workflow family.",
  "tasks": [
    { "name": "my-pack.collect", "module": "tasks/collect.mjs" }
  ]
}
```

Rules:

- one Pack contains 1–64 regular `.mjs` files below its own directory;
- names are unique lowercase identifiers and Pack versions use semantic versioning;
- modules are snapshotted and inspected in short-lived child processes before registration;
- the complete batch is validated before the registry changes; any conflict rejects all modules;
- reinstallation of the same name and source hash is idempotent, and installing that identical standalone type through a Pack safely attaches its Pack provenance;
- Pack provenance appears in task-type discovery.

Do not overwrite a registered task type with divergent source. Install a new versioned name, verify it, then run `task-types deprecate OLD_TYPE --replacement NEW_TYPE`. Ordinary discovery exposes only active types and execution of a deprecated type fails with its replacement hint. Use `task-types restore OLD_TYPE` only for an explicit rollback; immutable snapshots remain auditable throughout.

Task modules are trusted code, not an untrusted-code sandbox. Install only reviewed local Packs.

## Composition boundary

The base Skill owns startup, Profile choice, task IDs, queues, progress health, diagnostics, continuation, checkpoint resume, artifacts, and completion gating.

A specialized Skill owns:

- platform discovery and URL selection;
- selectors, pagination, expansion, parsing, deduplication, and coverage definitions;
- platform-specific rate limits, Retry-After interpretation, retry ceilings, and checkpoint fields;
- output schemas and proof of completion;
- business rules and domain terminology.

The specialized Skill should first search compact task summaries by domain/intent, describe the chosen task type, then use it through MCP. It should not expose module paths or tell the Agent to recreate Manager, Playwright launch, Profile leasing, screenshot fallback, or task-follow logic.

For one truly disposable workflow, a single-file task is enough. Use a Task Pack when two or more task types share a domain, when the workflow will be distributed, or when versioned installation matters.
