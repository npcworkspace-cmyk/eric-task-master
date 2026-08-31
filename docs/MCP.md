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
Automatically registered entries also carry the non-secret `ERIC_TASK_MASTER_RUNTIME_VERSION` marker so `connect` can require an Agent-host reload after an offline upgrade. Every Manager request from the bridge also carries the compiled runtime version. Missing or stale versions fail before task routing with HTTP 428 and `AGENT_HOST_RELOAD_REQUIRED`; task code must not use this version as an identity or authorization value.

Manager location may be overridden with `ERIC_TASK_MASTER_HOME`, `ERIC_TASK_MASTER_HOST`, and `ERIC_TASK_MASTER_PORT`. The host must remain exactly `127.0.0.1`.

STDOUT is reserved exclusively for MCP frames. STDERR remains a short error code. Safe Manager error messages, bounded safe details, and request IDs are returned through the structured tool error; request bodies, credentials, query strings, and local paths are not.

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
- `taskmaster_task_packs_list`
- `taskmaster_scale_prepare`
- `taskmaster_tasks_start`
- `taskmaster_tasks_list`
- `taskmaster_tasks_get`
- `taskmaster_tasks_wait`
- `taskmaster_agent_inbox_claim`
- `taskmaster_task_command_respond`
- `taskmaster_task_report_publish`
- `taskmaster_tasks_focus`
- `taskmaster_tasks_continue`
- `taskmaster_tasks_resume`
- `taskmaster_tasks_cancel`
- `taskmaster_artifacts_list`
- `taskmaster_artifacts_read`

Every tool publishes an input schema, output schema, and MCP annotations. Generic task start is conservatively marked destructive and open-world because the selected registered task type may interact with an external website. Task start requires an idempotency key; profile creation is explicitly marked non-idempotent because the current Manager profile API does not yet provide an idempotency contract.

`taskmaster_scale_prepare` is the one-call preflight for unknown large work. It accepts one Profile, representative HTTP(S) URL, optional label, and idempotency key, then dispatches the registered read-only `surface-probe`. The same probe is discoverable through ordinary task-type search. The Agent waits for that durable task and reads its declared artifact before authoring a bounded pilot; site-specific selectors and extraction still belong in a Task Pack. CAPTCHA or press-and-hold signals produce a structured same-task human handoff, never automated solving or bypass, and keep scale blocked until an explicit continuation proves the challenge is gone.

The MCP surface never accepts arbitrary module paths, JavaScript evaluation, cookie/session transfer, authorization headers, filesystem paths, or raw Playwright handles.

Profile creation accepts an immutable `browserEngine` of `chrome` or `chromium`. Persistent Profiles default to `chrome` with `human`; ephemeral Profiles default to `chromium` with Profile-owned `auto`. Both Profile kinds expose `fast`, `auto`, and `human`. Profile reads also expose the Owner's bounded `extensionsEnabled` next-launch policy. Only the Owner Console may change that policy; MCP cannot install, configure, inspect, or enable extensions. `taskmaster_tasks_start` accepts no task-level behavior override.

All Task Master runtime actions are serialized through one Worker FIFO; each Journey step retains its slot through transition verification and settling. A trusted extension implementing `taskmaster-cooperative-v2` shares that FIFO for click, input, DOM, and navigation actions with idempotent request IDs. MCP does not make arbitrary third-party extensions cooperative and cannot authenticate or guarantee their serialization; ordinary site scripts and extension content scripts are not reliably distinguishable from page events. Before the Owner operates an unintegrated extension, pause the task and wait for `paused`; resume then revalidates the page. Extension-enabled legacy tasks may mutate the page only through the `action` facade, not direct `page` or `context` calls. A post-effect proof failure is persisted as unknown and cannot be replayed automatically.

`taskmaster_profiles_update` changes only mutable Profile fields. Profiles have no creator or access-list field and are available to every trusted local Agent. It cannot change the browser engine. All three modes retain the same complete visible action mechanics and differ only in central pacing and guard depth. A behavior change for an active Profile is successful only after the running Worker confirms it; the task, browser, attempt, and lease remain intact.

## Long tasks, progress, and cancellation

`taskmaster_tasks_start` returns immediately with a durable task ID. Use `taskmaster_tasks_get` for a snapshot or `taskmaster_tasks_wait` for a bounded wait of at most 30 seconds. When the MCP request contains a progress token, the wait tool forwards bounded progress notifications. A wait also returns early when a task enters `waiting_user`, its health becomes `stalled`, or a durable Owner command arrives, so the Agent can inspect attention state rather than sleeping through it.

Task status separates liveness from advancement:

- `heartbeatAt` proves the Worker is still reporting;
- `progressAt` records the last meaningful module progress;
- `health.status` reports `healthy`, `stalled`, `waiting_user`, `cooling_down`, or a terminal state;
- `behaviorState` exposes configured/effective behavior plus `source`, `confirmed`, and Manager receipt time so callers can distinguish a Profile selection from actual Worker runtime state;
- `cooldown.resumeAt` exposes an active rate-limit deadline;
- `queuePosition` and `queueReason` explain bounded scheduler waiting.

Same-Profile work is FIFO queued. Different Profiles run concurrently up to the Manager budget. Queueing never requires a duplicate task submission.

When state is `waiting_user`, inspect `userRequest.kind`. Ordinary `instruction` requests use the existing diagnostic/read/continue path. A `human_verification` request is the only event that enters the durable notification center: enabled native, Telegram, and Feishu channels send immediately and every 30 seconds. It does not inherit the ordinary short handoff deadline. `taskmaster_tasks_focus` can bring the live page forward, but only the Owner Console may claim a human verification and stop reminders; the MCP surface intentionally has no human-claim tool, and Agent continuation is rejected until the Owner claim is durable. After the Owner finishes, `taskmaster_tasks_continue` revalidates and continues that same task ID, Worker, browser, output, checkpoint, and effect journal. Failures, stalls, cooldowns, cleanup, completion, login ambiguity, and ordinary instructions never generate these notifications.

Cancelling or disconnecting a wait request stops only that wait. The browser task continues under Task Master. Only `taskmaster_tasks_cancel` requests task cancellation. This prevents a transient MCP host disconnect from destroying a long task.

Call `taskmaster_agent_inbox_claim` after connection and whenever wait returns pending commands. Respond through `taskmaster_task_command_respond`; command IDs and expected task revisions prevent duplicate or stale application. Commands remain durable while the Agent is offline, but Manager cannot wake an arbitrary host process that is fully closed. Before final user handoff, publish a bounded report through `taskmaster_task_report_publish`. Reports remain available to the owning Agent and API clients; the deliberately small Owner Console renders only that bounded final report, never raw artifacts, diagnostics, logs, or Agent messages.

If a failed task exposes a preserved checkpoint and settled cleanup, `taskmaster_tasks_resume` starts a new attempt on the same task ID. It requires a stable `resumeKey`; retrying the same key is idempotent, while a new key is a new explicit resume decision. Resume fails closed for the wrong owner, a non-failed task, missing checkpoint, unsettled cleanup, missing persisted context, or a changed module snapshot. The caller must inspect the checkpoint and current site state before repeating any action whose external outcome is unknown.

A Worker completion claim is provisional. Manager publishes `completed` only after validating the bounded result shape, all declared Agent-visible artifacts, browser closure, Worker exit, and Profile lease release. Otherwise the task is `failed` with `TASK_COMPLETION_GATE_FAILED`.

Task-type discovery is progressive. `taskmaster_task_types_list` accepts `query`, `domain`, and `intent` and omits input schemas. After choosing one summary, call `taskmaster_task_types_describe` to read only that task's full input contract. This keeps routine discovery output small as Task Packs grow. Pack-backed types expose Pack lifecycle/discoverability plus `interactionContract: "full-human-v1"`; Manager forces those tasks through Human Journey and publishes `interaction-audit.json` only after its ten checks pass. `taskmaster_task_packs_list` is a bounded read-only inventory of Pack version, lifecycle, usage, discoverability, size, and machine-readable deletion-blocker classes; use its opaque `nextCursor` until absent when more than one page exists. Exact blocker task IDs are intentionally Owner-only and appear in the same-origin Console, where they can be opened directly.

Task Pack/executor mutation remains deliberately Owner-only. MCP exposes lifecycle visibility but no note, deprecate, restore, or delete operation. The same-origin Dashboard groups Packs, standalone/transient modules, protected system capabilities, history, and orphan snapshots; it exposes bounded purpose, notes, discovery state, lifecycle, usage, size, and backend-derived deletion blockers. Batch mutations are revalidated by Manager and serialized against task creation, so the browser UI is never trusted to decide whether an executable file is safe to remove. Logically deleted task history and unverified checkpoints do not block an asset; protected, live, cleanup-unsettled, and verified-resumable dependencies do.

Task Master 2.8.0 exposes no `externalCost` metadata, `externalCostBudget` task input, or paid-provider reserve/settle facade. New uses fail closed with `TASK_EXTERNAL_COST_UNSUPPORTED`. Provider authorization, budgets, idempotency, receipts, and stop conditions belong to the reviewed specialized Pack/Skill and its business orchestration outside this generic browser runtime. Legacy task history remains readable after private migration, but a task that depended on the removed runtime contract cannot be started or resumed.

Errors stay actionable without exposing internals. `TASK_INPUT_SCHEMA_FAILED` retains Manager's redacted field-level message, bounded `field`, `reason`, `expectedType`, and `receivedType` details, plus the correlated `requestId`; its single recovery action is to describe the already-selected type and correct the named field. Trusted Task Pack code may raise one bounded public failure with category `input`, `precondition`, `provider`, `navigation`, `data`, or `runtime`, a stable code, safe public message, up to eight field details, and one next action. MCP exposes only that allowlisted contract; arbitrary exception text stays generic and private. `AGENT_HOST_RELOAD_REQUIRED` is non-retryable inside the current host process: reload that Agent host once, call `taskmaster_status`, and only then submit work. Manager appends allowlisted events to `logs/manager-events.jsonl`, rotated at 5 MiB across three files with protected permissions; MCP returns the same request ID so the event can be correlated without a second file writer. `node scripts/taskmaster.mjs doctor --json` summarizes Manager status, MCP registration, and recent redacted errors without starting another Manager or browser; logs are diagnostics, never task output.

Every successful `taskmaster_tasks_start` result begins with a clickable Owner Console link focused on that task. The first authorized link silently creates a persistent local `HttpOnly` Owner cookie; after that the fixed bookmarked Dashboard URL works across Manager restarts. When the user says “启动任务面板”, call `taskmaster_dashboard_open` and return its clickable link; the tool does not launch an operating-system browser.

## Output and artifact bounds

- Manager JSON responses: at most 1 MiB.
- MCP structured tool result: at most 256 KiB.
- Artifact read chunk: at most 48 KiB. Automatic diagnostic screenshots are complete JPEG previews within that ceiling and should be requested from offset `0` in one read; partial image chunks are never presented as images.
- Agent-visible artifact chunks are byte-preserving; the task author must never mark credential-bearing files Agent-visible.
- Lists: at most 100 records per MCP response.

Public views are explicit allowlists. Local paths, leases, execution modules, credentials, unredacted Manager internals, and unsafe evidence are removed. Artifact content is returned only when the manager marks the artifact with `agentVisible: true`; missing visibility fails closed.

## Protocol compatibility

The STDIO entry uses the official `@modelcontextprotocol/server` v2 `serveStdio(factory)` adapter and supports both legacy 2025 clients and modern 2026-07-28 negotiation. `ping` is exercised for legacy clients; the modern 2026-07-28 era does not expose the legacy ping method. Both eras are spawn-tested for tool discovery and tool calls.
