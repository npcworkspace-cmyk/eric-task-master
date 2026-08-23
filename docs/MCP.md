# Task Master MCP

Task Master exposes a local, high-level MCP surface over STDIO. The MCP process does not execute browser code itself. It submits registered task types to the loopback Task Master manager and returns durable task IDs, bounded status, progress, and explicitly agent-visible artifacts.

## Stable STDIO entry

Configure each MCP host to spawn:

```text
node <absolute-project-path>/src/mcp/stdio.mjs
```

Required environment:

- `TASKMASTER_CLIENT_ID`: stable identifier unique to this host registration.
- `TASKMASTER_CLIENT_NAME`: optional human-readable host name.

`ERIC_TASK_MASTER_CLIENT_ID` and `ERIC_TASK_MASTER_CLIENT_NAME` are accepted as compatibility aliases.

Manager location may be overridden with `ERIC_TASK_MASTER_HOME`, `ERIC_TASK_MASTER_HOST`, and `ERIC_TASK_MASTER_PORT`. The host must remain exactly `127.0.0.1`.

STDOUT is reserved exclusively for MCP frames. Diagnostics go to STDERR as a short error code without request bodies, tokens, paths, or remote error text.

## Authentication boundary

On the first manager operation, the HTTP client reads the locally protected Manager credential and Ed25519 public identity pin. It first sends a fresh 256-bit nonce to `POST /v1/identity/challenge` without an Authorization header. The signed response must bind `eric-task-master`, the exact project/API version, `127.0.0.1`, the configured port, and that nonce. Wrong keys, stale/replayed signatures, port occupants, and any binding mismatch fail before the admin credential is placed in a request.

Only after that proof succeeds does the client call:

```text
POST /v1/agents/issue
{ "clientId": "...", "name": "..." }
```

The response contract is:

```text
{ "agentToken": "...", "agent": { "clientId": "...", "name": "..." } }
```

The admin credential is used only for that exchange. Profiles, task types, tasks, and artifacts use the scoped agent token. A Manager without the identity challenge or scoped-agent endpoints fails closed. Identity failures and diagnostics go to STDERR only, so STDOUT remains exclusively MCP protocol frames.

## Tool surface

- `taskmaster_status`
- `taskmaster_profiles_list`
- `taskmaster_profiles_create`
- `taskmaster_profiles_open`
- `taskmaster_profiles_close`
- `taskmaster_task_types_list`
- `taskmaster_tasks_start`
- `taskmaster_tasks_list`
- `taskmaster_tasks_get`
- `taskmaster_tasks_wait`
- `taskmaster_tasks_resume`
- `taskmaster_tasks_cancel`
- `taskmaster_artifacts_list`
- `taskmaster_artifacts_read`

Every tool publishes an input schema, output schema, and MCP annotations. Generic task start is conservatively marked destructive and open-world because the selected registered task type may interact with an external website. Task start requires an idempotency key; profile creation is explicitly marked non-idempotent because the current Manager profile API does not yet provide an idempotency contract.

The MCP surface never accepts arbitrary module paths, JavaScript evaluation, cookie/session transfer, authorization headers, filesystem paths, or raw Playwright handles.

## Long tasks, progress, and cancellation

`taskmaster_tasks_start` returns immediately with a durable task ID. Use `taskmaster_tasks_get` for a snapshot or `taskmaster_tasks_wait` for a bounded wait of at most 30 seconds. When the MCP request contains a progress token, the wait tool forwards bounded progress notifications.

Cancelling or disconnecting a wait request stops only that wait. The browser task continues under Task Master. Only `taskmaster_tasks_cancel` requests task cancellation. This prevents a transient MCP host disconnect from destroying a long task.

If a failed task exposes a preserved checkpoint and settled cleanup, `taskmaster_tasks_resume` starts a new attempt on the same task ID. It requires a stable `resumeKey`; retrying the same key is idempotent, while a new key is a new explicit resume decision. Resume fails closed for the wrong owner, a non-failed task, missing checkpoint, unsettled cleanup, missing persisted context, or a changed module snapshot. The caller must inspect the checkpoint and current site state before repeating any action whose external outcome is unknown.

A Worker completion claim is provisional. Manager publishes `completed` only after validating the bounded result shape, all declared Agent-visible artifacts, browser closure, Worker exit, and Profile lease release. Otherwise the task is `failed` with `TASK_COMPLETION_GATE_FAILED`.

## Output and artifact bounds

- Manager JSON responses: at most 1 MiB.
- MCP structured tool result: at most 256 KiB.
- Artifact read chunk: at most 48 KiB.
- Agent-visible artifact chunks are byte-preserving; the task author must never mark credential-bearing files Agent-visible.
- Lists: at most 100 records per MCP response.

Public views are explicit allowlists. Process IDs, local paths, leases, execution modules, credentials, raw manager errors, and unsafe evidence are removed. Artifact content is returned only when the manager marks the artifact with `agentVisible: true`; missing visibility fails closed.

## Protocol compatibility

The STDIO entry uses the official `@modelcontextprotocol/server` v2 `serveStdio(factory)` adapter and supports both legacy 2025 clients and modern 2026-07-28 negotiation. `ping` is exercised for legacy clients; the modern 2026-07-28 era does not expose the legacy ping method. Both eras are spawn-tested for tool discovery and tool calls.
