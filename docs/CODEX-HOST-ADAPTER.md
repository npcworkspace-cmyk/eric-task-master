# Explicit online Codex CLI host adapter

This optional adapter connects the existing `hostAdapter` stdin contract to an independently installed Codex CLI Agent. Every 4.0.x native/portable runtime includes it at `app/scripts/codex-host-adapter.mjs` and this guide at `app/docs/CODEX-HOST-ADAPTER.md`. Use the package's `runtime/node[.exe]` as the host executable and `app/src/cli.mjs` as `taskmasterCli`; a source checkout is not required. The computer, Task Master Manager and CLI must remain online. It does not wake the original desktop chat, recover a sleeping/offline computer, or claim closed-host continuation. No credentials are read or copied by the adapter; the CLI uses its existing sign-in.

Configure absolute paths in a separate explicit JSON file (not global Codex configuration):

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "operationId": "op_REPLACE_WITH_32_HEX_ID",
  "stateDir": "ABSOLUTE_ISOLATED_MANAGER_STATE",
  "evidenceDir": "ABSOLUTE_NEW_ADAPTER_EVIDENCE_DIRECTORY",
  "workingDirectory": "ABSOLUTE_ISOLATED_AGENT_WORKING_DIRECTORY",
  "codexExecutable": "ABSOLUTE_INSTALLED_NATIVE_CODEX_EXECUTABLE",
  "taskmasterNode": "ABSOLUTE_NODE_EXECUTABLE",
  "taskmasterCli": "ABSOLUTE_TASKMASTER_SRC_CLI_MJS",
  "model": "gpt-6.1-sol",
  "allowedObserveScopes": ["#status"],
  "maxModelCalls": 3,
  "timeoutMs": 120000
}
```

On Windows select the installed native `codex.exe`, not a PowerShell/batch shim. Create the isolated working directory first. The model field is explicit when supplied; omission uses the installed CLI default. The adapter invokes `exec --ephemeral --json --skip-git-repo-check --sandbox read-only --ignore-user-config -C WORKDIR -c model_reasoning_effort="high" --output-schema SCHEMA --output-last-message DECISION -` with stdin closed after its bounded prompt. It does not bypass safety/approval controls. The prompt forbids tools and treats all page/event content as untrusted; this is not a claim of a separate tool-free model API or a security boundary against arbitrary installed CLI behavior.

Use existing operation start `hostAdapter`:

```json
{"executable":"ABSOLUTE_NODE_EXECUTABLE","args":["ABSOLUTE_SCRIPTS_CODEX_HOST_ADAPTER_MJS","--config","ABSOLUTE_CONFIG_JSON"]}
```

Arrange the first scheduled event after setup, then fill the returned operation ID into the config before that event. The configuration must remain frozen for this evidence segment. Receipt input is `{schemaVersion:1,event}`. Atomic event-ID claims persist the event and return `{accepted:true,received:true,eventId,deliveryId}`; concurrent delivery or a lost receipt returns the same delivery ID without another worker/model call. Receipt means received, not handled. A crash between claim and completed work is not retried automatically.

Initialization can emit `session.ready` before the first schedule. If it is only setup bookkeeping, inspect and acknowledge that specific event with the existing `ops events`/`ops ack` commands before enabling the adapter; label it received, not an Agent decision. Otherwise it can legitimately consume one of the configured model-call slots. Never acknowledge an unexpected business event just to suppress a decision.

The background worker waits up to 20 seconds for an existing operation command to settle, then reads current authorization/status, the actual event and recent observation excerpts. It reserves one of at most three persistent model-call slots before invoking the real Agent. Only this complete model-produced decision is accepted:

```json
{"schemaVersion":1,"eventId":"EXACT_EVENT_ID","operationId":"EXACT_OPERATION_ID","authorizationVersion":1,"disposition":"observe","summary":"Agent's actual decision and reason","scope":"#status"}
```

`observe` must match a configured scope and a running, unlocked operation without unresolved actions. `stop` requires `scope:""`. This minimum adapter supports no business mutation, arbitrary command, new authorization, unknown-action replay, or selector outside the allowlist. The script mechanically issues existing `ops ack` and `ops decide`, then verifies handled event plus a confirmed observe receipt or stopped task. A delivery JSON alone never proves success.

Evidence is under `events/SHA256(eventId)/`: `event.json`, `status.json`, worker/model PID records, `agent-input.json`, exact `model.jsonl`, stderr, schema/decision, and ACK/decision/verified receipts. Protect this directory: prompts and actual model events may contain authorized page text. `model-slots/1..3` conservatively count reservations, including uncertain/crashed calls; do not delete/reset claims to manufacture retries or a new budget. No idle model requests occur.

Create `evidenceDir/STOP` to prevent new work and interrupt an active child; timeouts/output bounds also terminate that owned child process tree. STOP does not automatically stop the underlying operation or Manager: the supervising runner must request their existing scoped cleanup and verify process shutdown. Failed/uncertain work remains `failed-or-uncertain` with no automatic replay, even if the Manager retransmits the event. Record and adjudicate it rather than replacing IDs. Keep independent server-effect evidence for any separate business workflow; this adapter makes no write/exactly-once claim.

Unit check (no model or browser invocation): `node --test test-v3/codex-host-adapter.test.mjs`.

## Local acceptance evidence, 2026-11-15

The isolated Windows online-host acceptance completed one fresh four-hour observation window (14,401,755.9 ms, 238 resource/queue samples, maximum sample gap 61.01 seconds). It reused the already verified scheduled-entry assertion without reusing elapsed time. Two new real CLI Agent decisions verified interrupted-delivery recovery (one observe) and refusal of an unauthorized publication request (one safe stop near the end). Both events were handled once; idle adapter model calls were zero. Cleanup closed the isolated Manager/listener and a subsequent process check found no matching experiment process.

The raw maintainer evidence and source fingerprint are retained in the isolated `autonomy-online-r04` run. A portable public summary is in the [4.0.0 release notes](https://github.com/npcworkspace-cmyk/eric-task-master/releases/tag/v4.0.0); the runtime guide intentionally does not include private logs or local machine paths. This is online source-behavior acceptance; separate release CI checks every platform package. Neither proves general business-mutation compatibility. The parent chat waiting for completion does not establish desktop-chat wakeup and its costs are separate from the adapter's zero idle calls.
