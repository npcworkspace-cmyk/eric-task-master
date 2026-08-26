# Task Master MCP

Task Master exposes a local, high-level MCP surface over STDIO. The MCP process does not execute browser code itself. It submits registered task types to the loopback Task Master manager and returns durable task IDs, bounded status, progress, and explicitly agent-visible artifacts.

This document defines the MCP-first Agent path. Each host starts its own STDIO bridge and all bridges reuse the same local Manager; multiple Agents never share one STDIO pipe. A host reported as `adapter_pending` or `extension_required` must not invent a registration. It may temporarily use the fixed, Agent-scoped CLI fallback in [`MCP-HOSTS.md`](./MCP-HOSTS.md), which issues the same kind of scoped Manager identity but is not an MCP connection.

## Stable STDIO entry

Configure each MCP host to spawn:

```text
node <absolute-project-path>/src/mcp/stdio.mjs
```

Required environment:

- `TASKMASTER_CLIENT_ID`: stable identifier unique to this host registration.
- `TASKMASTER_CLIENT_NAME`: optional human-readable host name.

`ERIC_TASK_MASTER_CLIENT_ID` and `ERIC_TASK_MASTER_CLIENT_NAME` are accepted as compatibility aliases.
Automatically registered entries also carry the non-secret `ERIC_TASK_MASTER_RUNTIME_VERSION` marker so `connect` can require an Agent-host reload after an offline upgrade. Task code must not use it as an identity or authorization value.

Manager location may be overridden with `ERIC_TASK_MASTER_HOME`, `ERIC_TASK_MASTER_HOST`, and `ERIC_TASK_MASTER_PORT`. The host must remain exactly `127.0.0.1`.

STDOUT is reserved exclusively for MCP frames. Diagnostics go to STDERR as a short error code without request bodies, tokens, paths, or remote error text.

## Authentication boundary

On the first manager operation, the HTTP client reads the locally protected Manager credential and Ed25519 public identity pin. It first sends a fresh 256-bit nonce to `POST /v1/identity/challenge` without an Authorization header. The signed response must bind `eric-task-master`, the exact project/API version, `127.0.0.1`, the configured port, and that nonce. Wrong keys, stale/replayed signatures, port occupants, and any binding mismatch fail before the admin credential is placed in a request.

Only after that proof succeeds does the client call:

```text
POST /v1/agents/issue
{ "clientId": "...", "name": "...", "connectionId": "..." }
```

The response contract is:

```text
{ "agentToken": "...", "agent": { "clientId": "...", "name": "..." } }
```

The admin credential is used only for that exchange. The per-process `connectionId` stays stable across ordinary requests and a 401 re-issue, allowing the Owner Console to derive presence without treating every request as a new Agent. Profiles, task types, tasks, and artifacts use the scoped agent token. A Manager without the identity challenge or scoped-agent endpoints fails closed. Identity failures and diagnostics go to STDERR only, so STDOUT remains exclusively MCP protocol frames.

This is trusted-local-Agent coordination, not hostile multi-tenant security. Agent client IDs scope task history and the Owner-command inbox; every trusted Agent shares the Profile catalog. MCP processes running as the same operating-system user can read the same protected Manager bootstrap credential and are therefore trusted peers. The Owner can revoke an Agent in the Console, and Manager credential rotation invalidates all scoped tokens. Run mutually untrusted Agents under separate OS users, sandboxes, or machines.

## Tool surface

- `taskmaster_status`
- `taskmaster_dashboard_open`
- `taskmaster_profiles_list`
- `taskmaster_profiles_create`
- `taskmaster_profiles_update`
- `taskmaster_profiles_open`
- `taskmaster_profiles_close`
- `taskmaster_task_types_list`
- `taskmaster_task_types_describe`
- `taskmaster_tasks_start`
- `taskmaster_tasks_list`
- `taskmaster_tasks_get`
- `taskmaster_tasks_wait`
- `taskmaster_agent_inbox_claim`
- `taskmaster_task_command_respond`
- `taskmaster_task_report_publish`
- `taskmaster_tasks_continue`
- `taskmaster_tasks_resume`
- `taskmaster_tasks_cancel`
- `taskmaster_artifacts_list`
- `taskmaster_artifacts_read`

Every tool publishes an input schema, output schema, and MCP annotations. Generic task start is conservatively marked destructive and open-world because the selected registered task type may interact with an external website. Task start requires an idempotency key; profile creation is explicitly marked non-idempotent because the current Manager profile API does not yet provide an idempotency contract.

The MCP surface never accepts arbitrary module paths, JavaScript evaluation, cookie/session transfer, authorization headers, filesystem paths, or raw Playwright handles.

Profile creation accepts an immutable `browserEngine` of `chrome` or `chromium`. Persistent Profiles default to `chrome` with `human`; ephemeral Profiles default to `chromium` with Profile-owned `auto`. Both Profile kinds expose `fast`, `auto`, and `human`. `taskmaster_tasks_start` accepts no task-level behavior override.

`taskmaster_profiles_update` changes only mutable Profile fields. Profiles have no creator or access-list field and are available to every trusted local Agent. It cannot change the browser engine. A behavior change for an active Profile is successful only after the running Worker confirms it; the task, browser, attempt, and lease remain intact.

## Long tasks, progress, and cancellation

`taskmaster_tasks_start` returns immediately with a durable task ID. Use `taskmaster_tasks_get` for a snapshot or `taskmaster_tasks_wait` for a bounded wait of at most 30 seconds. When the MCP request contains a progress token, the wait tool forwards bounded progress notifications. A wait also returns early when a task enters `waiting_user`, its health becomes `stalled`, or a durable Owner command arrives, so the Agent can inspect attention state rather than sleeping through it.

Task status separates liveness from advancement:

- `heartbeatAt` proves the Worker is still reporting;
- `progressAt` records the last meaningful module progress;
- `health.status` reports `healthy`, `stalled`, `waiting_user`, `cooling_down`, or a terminal state;
- `behaviorState` exposes configured and currently effective behavior;
- `cooldown.resumeAt` exposes an active rate-limit deadline;
- `queuePosition` and `queueReason` explain bounded scheduler waiting.

Same-Profile work is FIFO queued. Different Profiles run concurrently up to the Manager budget. Queueing never requires a duplicate task submission.

When state is `waiting_user`, list/read the task's `diagnostic-observation` and `diagnostic-screenshot` artifacts, then call `taskmaster_tasks_continue` with the live request ID and an optional bounded note. This keeps the same task ID, Worker, browser, output, checkpoint, and effect journal. It is intentionally non-idempotent and open-world because a new instruction may lead to an external browser action.

Cancelling or disconnecting a wait request stops only that wait. The browser task continues under Task Master. Only `taskmaster_tasks_cancel` requests task cancellation. This prevents a transient MCP host disconnect from destroying a long task.

Call `taskmaster_agent_inbox_claim` after connection and whenever wait returns pending commands. Respond through `taskmaster_task_command_respond`; command IDs and expected task revisions prevent duplicate or stale application. Commands remain durable while the Agent is offline, but Manager cannot wake an arbitrary host process that is fully closed. Before final user handoff, publish a bounded report through `taskmaster_task_report_publish`. Reports remain available to the owning Agent and API clients; the deliberately small Owner Console shows task progress and lifecycle controls but does not render reports, diagnostics, logs, or artifacts.

If a failed task exposes a preserved checkpoint and settled cleanup, `taskmaster_tasks_resume` starts a new attempt on the same task ID. It requires a stable `resumeKey`; retrying the same key is idempotent, while a new key is a new explicit resume decision. Resume fails closed for the wrong owner, a non-failed task, missing checkpoint, unsettled cleanup, missing persisted context, or a changed module snapshot. The caller must inspect the checkpoint and current site state before repeating any action whose external outcome is unknown.

A Worker completion claim is provisional. Manager publishes `completed` only after validating the bounded result shape, all declared Agent-visible artifacts, browser closure, Worker exit, and Profile lease release. Otherwise the task is `failed` with `TASK_COMPLETION_GATE_FAILED`.

Task-type discovery is progressive. `taskmaster_task_types_list` accepts `query`, `domain`, and `intent` and omits input schemas. After choosing one summary, call `taskmaster_task_types_describe` to read only that task's full input contract. This keeps routine discovery output small as Task Packs grow. Pack-backed types expose `interactionContract: "full-human-v1"`; Manager forces those tasks through Human Journey and publishes `interaction-audit.json` only after its ten checks pass.

Every successful `taskmaster_tasks_start` result begins with a clickable Owner Console link focused on that task. The first authorized link silently creates a persistent local `HttpOnly` Owner cookie; after that the fixed bookmarked Dashboard URL works across Manager restarts. When the user says “启动任务面板”, call `taskmaster_dashboard_open` and return its clickable link; the tool does not launch an operating-system browser.

## Output and artifact bounds

- Manager JSON responses: at most 1 MiB.
- MCP structured tool result: at most 256 KiB.
- Artifact read chunk: at most 48 KiB. Automatic diagnostic screenshots are complete JPEG previews within that ceiling and should be requested from offset `0` in one read; partial image chunks are never presented as images.
- Agent-visible artifact chunks are byte-preserving; the task author must never mark credential-bearing files Agent-visible.
- Lists: at most 100 records per MCP response.

Public views are explicit allowlists. Process IDs, local paths, leases, execution modules, credentials, raw manager errors, and unsafe evidence are removed. Artifact content is returned only when the manager marks the artifact with `agentVisible: true`; missing visibility fails closed.

## Protocol compatibility

The STDIO entry uses the official `@modelcontextprotocol/server` v2 `serveStdio(factory)` adapter and supports both legacy 2025 clients and modern 2026-07-28 negotiation. `ping` is exercised for legacy clients; the modern 2026-07-28 era does not expose the legacy ping method. Both eras are spawn-tested for tool discovery and tool calls.
