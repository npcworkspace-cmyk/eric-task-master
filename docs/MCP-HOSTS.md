# MCP host registration

Eric Task Master does **not** depend on a fictional operating-system-wide MCP registry. The MCP protocol discovers tools only after a client has connected to a server. This project therefore detects each installed host and registers one local STDIO bridge through that host's verified configuration or official CLI. Every host owns its STDIO process; all bridges reuse the same Task Master Manager, Profiles, scheduler, and durable tasks.

The fixed server process is:

```text
<absolute Node.js path> <absolute project path>/src/mcp/stdio.mjs
```

Every native host entry receives two non-secret identity values, mirrored under
the current `ERIC_TASK_MASTER_*` names and the compatibility `TASKMASTER_*`
names, plus one non-secret runtime-version marker used to detect a stale Agent
bridge after upgrades:

- `ERIC_TASK_MASTER_CLIENT_ID` / `TASKMASTER_CLIENT_ID` = `<installationId>:<hostKey>`
- `ERIC_TASK_MASTER_CLIENT_NAME` / `TASKMASTER_CLIENT_NAME` = `Eric Task Master / <host name>`
- `ERIC_TASK_MASTER_RUNTIME_VERSION` = the registered Task Master runtime version

No Manager admin token, agent token, cookie, or browser credential is written to host configuration. The STDIO adapter obtains local Manager authority at runtime and exchanges it for a scoped Agent session.

## One command, separate host registrations

Run a preview first, then install:

```bash
node scripts/register-mcp.mjs install --dry-run --json
node scripts/register-mcp.mjs install --json
node scripts/register-mcp.mjs status --json
```

The result contains one record per host. `mcpCapability` describes what the host can do; `autoRegistration` describes whether Task Master has a verified adapter. Typical operation states are `registered_pending_restart`, `registered_pending_reload`, `registered_pending_approval_or_reload`, `registered_disabled`, `adopted`, `registered`, `adapter_pending`, `extension_required`, `not_installed`, `conflict`, and `failed`. The legacy `support` field remains for response compatibility and must not be interpreted as the host's MCP capability. `registered_disabled` means that the host deliberately retained but disabled the entry; enable it in that host and reload once. The registrar never bypasses approvals, silently reenables a disabled entry, or kills or restarts an Agent, Manager, browser, or running task.

`configurationStatus: registered` proves only that the saved entry matches. `activationStatus: not_verified` means the running host has not been proved through this registration command. Only a successful MCP `taskmaster_status` call proves the live bridge is active.

## Two fixed Agent operation paths

Bootstrap is identical for every host: from the complete project root run `node scripts/taskmaster.mjs connect --json` once and follow its `nextAction`. When it returns `manager.agentHostReloadRequired: true`, reload the current Agent host once because its already-running bridge may still be the previous version; the upgraded Manager remains running. After that, choose one path and keep it for the whole task:

1. **MCP path:** this is the default. For any `registered_pending_*` status, complete the named one-time approval or reload. For `registered_disabled`, enable `eric-task-master` in that host and reload once. For `registered` or `adopted`, configuration is already in place. In every case verify the live host with `taskmaster_status`, then use only the `taskmaster_*` tools in [`MCP.md`](./MCP.md).
2. **Emergency scoped CLI fallback:** use this only for `adapter_pending`, `extension_required`, or for the current run when a registered host cannot reload itself. Do not invent a host configuration, daemon, port, direct Manager request, or temporary controller. Use only `node scripts/taskmaster.mjs ... --json` from the complete project root. Every scoped command requires the same `--agent-id STABLE_ID`; `--agent-name AGENT_NAME` supplies its display name. Different independent Agents need different stable IDs; all trusted Agents share the Profile catalog, while the same ID intentionally shares that principal's task ledger and Owner-command inbox. A missing or misspelled Agent ID fails closed instead of silently joining a default identity. After the prerequisite is resolved, use MCP for new tasks; never switch identities or mix MCP and CLI inside one task.

The fixed no-adapter flow is:

```text
node scripts/taskmaster.mjs status --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs profiles list --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task inbox --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task-types list --query QUERY --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task-types describe TYPE --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task start --profile PROFILE_ID --type TYPE --input @INPUT_FILE.json --request-key STABLE_REQUEST_KEY --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task wait TASK_ID --wait-ms 30000 --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task status TASK_ID --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs artifacts list TASK_ID --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs artifacts read TASK_ID --artifact ARTIFACT_ID --agent-id STABLE_ID --agent-name AGENT_NAME --json
```

Replace the uppercase placeholders before running a command. `task start` accepts registered task types only, rejects `--module`, returns immediately with a durable task ID and task-focused Dashboard URL, and requires a stable request key. Repeat the bounded `task wait` on that same ID; a timeout or CLI exit never means “submit again” and does not cancel the browser task.

Attention and recovery commands use the same stable Agent identity:

```text
node scripts/taskmaster.mjs dashboard-open [TASK_ID] --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task list --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task continue TASK_ID --request-id REQUEST_ID --note NOTE --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task resume TASK_ID --resume-key STABLE_RESUME_KEY --detach --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task cancel TASK_ID --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task command-respond TASK_ID --command-id COMMAND_ID --revision REVISION --status acknowledged --message NOTE --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs task report TASK_ID --report-id REPORT_ID --revision REVISION --status final --title TITLE --summary SUMMARY --sections SECTIONS_JSON --agent-id STABLE_ID --agent-name AGENT_NAME --json
```

Profile creation and mutable settings use the same identity:

```text
node scripts/taskmaster.mjs profiles create --name NAME --kind persistent --engine chrome --behavior human --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs profiles create --name NAME --kind ephemeral --engine chromium --behavior adaptive --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs profiles update PROFILE_ID --name NAME --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs profiles open PROFILE_ID --agent-id STABLE_ID --agent-name AGENT_NAME --json
node scripts/taskmaster.mjs profiles close PROFILE_ID --agent-id STABLE_ID --agent-name AGENT_NAME --json
```

Persistent behavior is fixed to `human`; an ephemeral Profile may be updated to `fast`, `adaptive`, or `human` with `profiles update PROFILE_ID --behavior MODE ...`. The browser engine is immutable. `task-types install` and `task-packs install` are local authoring commands, not the standard no-adapter Agent task loop.

CLI identities provide the same trusted-local task attribution as registered MCP client IDs. Profiles are intentionally global, while task records, artifacts, reports, and command inboxes remain scoped. This is not a hostile tenant boundary. Do not mix MCP and CLI identities inside one task. Mutually untrusted Agents require separate operating-system users, sandboxes, or machines.

Tasks created through the former v2.0.0 administrator CLI do not belong to a new scoped CLI identity. They remain available to the user through the locally authorized Manager Dashboard; ordinary Agent commands never fall back to administrator access to expose them.

Removal and recovery are equally explicit:

```bash
node scripts/register-mcp.mjs uninstall --dry-run --json
node scripts/register-mcp.mjs uninstall --json
node scripts/register-mcp.mjs rollback --transaction <id> --json
```

If the checkout is intentionally moved, relocate the saved installation before
running another install:

```bash
node scripts/register-mcp.mjs relocate --from <previous-absolute-project-root> --json
node scripts/register-mcp.mjs install --json
```

`relocate` requires the exact previously recorded root, verifies the new MCP
entrypoint, and preserves the installation identity. A moved checkout otherwise
fails closed instead of silently registering a second owner.

`rollback` restores the exact pre-transaction bytes only when each host file is
still in a state known to that transaction. It reports the real result for every
host, leaves conflicts unresolved, and can be rerun to finish only the actions
that did not succeed. A later user or host edit is never overwritten.

## Host contracts

| Host | MCP capability | Registration surface | Automatic status / validation |
| --- | --- | --- | --- |
| Codex app, CLI, IDE | native | `mcp_servers` in `$CODEX_HOME/config.toml` or `~/.codex/config.toml` | file adapter; live local tool call verified |
| Claude Desktop | native | `mcpServers` in the platform Desktop config | file adapter; host reload still proves activation |
| Claude Code | native | user `mcpServers` in `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json` | file adapter; live host validation requires Claude Code installed |
| WorkBuddy Desktop | native | `mcpServers` in `~/.workbuddy/mcp.json` | file adapter; live WorkBuddy-launched STDIO verified |
| CodeBuddy CLI | native | first existing user registry in `~/.codebuddy/.mcp.json`, `mcp.json`, then `.codebuddy.json` | JSONC file adapter; fixture and cross-platform path validation |
| Hermes Agent | native | `mcp_servers` in `$HERMES_HOME/config.yaml` or `~/.hermes/config.yaml` | file adapter; live discovery of 21 tools plus status and Profile-list calls verified |
| Gemini CLI | native | `mcpServers` in `~/.gemini/settings.json` | file adapter; fixture and cross-platform path validation |
| OpenClaw | native | official `openclaw mcp list/set/unset` commands | official-CLI adapter; real-host validation pending |
| DeepSeek Harness (DSH) | first-party MCP extension | version-matched `@deepseek-ai/dsh-mcp-client` Cordis overlay | `adapter_pending`; never rewrites Cordis blindly |
| Pi Coding Agent | extension-defined MCP | reviewed Pi extension/package required | `extension_required`; no silent third-party install |
| VS Code / GitHub Copilot | native | official `code --add-mcp` user-profile command or host-managed registry | `adapter_pending`; official-CLI install, inspection, and reversible removal still need versioned validation |
| OpenCode | native | V2 `mcp.servers` registry and version-specific CLI | `adapter_pending`; versioned install, inspection, and reversible removal contract still needs validation |

TaskMaster-specific path overrides are also available for controlled deployments and tests: `TASKMASTER_CODEX_CONFIG`, `TASKMASTER_CLAUDE_DESKTOP_CONFIG`, `TASKMASTER_CLAUDE_CODE_CONFIG`, `WORKBUDDY_MCP_CONFIG`, `CODEBUDDY_MCP_CONFIG`, `TASKMASTER_HERMES_CONFIG`, and `GEMINI_MCP_CONFIG`.

The accepted adapters are based on the documented contracts for [OpenAI Codex MCP](https://developers.openai.com/codex/mcp/), [Claude Desktop local MCP](https://github.com/modelcontextprotocol/docs/blob/main/quickstart/user.mdx), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [WorkBuddy MCP](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide), [CodeBuddy CLI MCP](https://www.workbuddy.cn/docs/cli/mcp), [Hermes MCP](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md), [Gemini CLI MCP](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md), and [OpenClaw MCP](https://github.com/openclaw/openclaw/blob/main/docs/cli/mcp.md). [VS Code MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers) and [OpenCode V2 MCP](https://v2.opencode.ai/docs/mcp-servers/) confirm native support, but their automatic adapters remain pending until Task Master can inspect and reverse every change. [DSH MCP examples](https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/mcp-memory/README.md) and [Pi's coding-agent design](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md#design-principles) define extension-specific boundaries rather than a generic writable registry. The [MCP Registry FAQ](https://modelcontextprotocol.io/registry/faq) describes a public metadata registry, not local host registration.

## Safety and ownership

Registration state is stored under `$ERIC_TASK_MASTER_HOME/registration` (default `~/.eric-task-master/registration`) unless `--state-dir` or `TASKMASTER_REGISTRATION_HOME` is set. It contains:

- a stable random `installationId`;
- one ownership record per registered host;
- SHA-256 hashes of the owned entry and before/after files;
- exact pre-change backups under `backups/<transactionId>/`;
- a bounded transaction journal.

One cross-process registration lock covers discovery, preflight, every host
write, journaling, rollback, and cleanup. Stale-lock takeover is itself guarded
by a second exclusive recovery owner, so two recovering processes cannot both
enter the transaction. A completed operation whose lock cannot be released is
reported as `REGISTRATION_LOCK_RELEASE_FAILED`, with the committed operation
result retained for diagnosis; it is never returned as an ordinary success.

Immediately before publishing a host file, the registrar checks that its
existence, identity, and SHA-256 hash still match the preflight snapshot. An
existing file is first atomically displaced into an owner-only same-directory
CAS folder and verified; the new file is then hard-linked into place with
no-replace semantics. Creation also uses no-replace publication. A concurrent
edit is restored to its original pathname or preserved in the CAS folder for
explicit recovery, never overwritten. An interrupted displacement is repaired
or rejected on the next operation. Filesystems used for live acceptance must
support same-directory rename and hard-link semantics.

The journal records `prepared` and `applying` states; the next command first
restores any provably changed files, and otherwise fails closed with an explicit
recovery conflict.

Installation is idempotent. Existing unrelated servers and keys are retained.
An existing `eric-task-master` entry without the matching installation identity
is a conflict and is never adopted or overwritten. Uninstall removes only an
owned entry whose fingerprint still matches the recorded fingerprint. A host
configuration path that is a symbolic link, or is not a regular file, is
rejected rather than followed or replaced.

WorkBuddy Desktop is intentionally narrower than the generic JSON contract. Task Master writes only `~/.workbuddy/mcp.json`; it never writes WorkBuddy's internal `~/.workbuddy/.mcp.json` connector proxy or `mcp-approvals.json`. An existing WorkBuddy entry can be adopted without rewriting the file only when it uses an absolute Node executable, this installation's exact STDIO entrypoint and client IDs, and either the current or the known legacy WorkBuddy display name. WorkBuddy-managed metadata and extra environment fields are preserved, while any other change to managed launch or identity fields fails closed.

JSON files are parsed and semantically merged. Invalid JSON/JSONC and duplicate
object keys at any depth are rejected without a write. CodeBuddy's JSONC
comments and trailing commas are accepted, then normalized on a managed write;
other JSON hosts remain strict. TOML and YAML are changed only in the exact
`eric-task-master` block. Bare, single-quoted, or double-quoted same-name
entries, duplicate semantic roots/entries, and unsupported non-empty YAML flow
mappings fail closed; unfamiliar structures are not rewritten.

Backups are byte-for-byte copies of pre-existing configuration and can therefore
contain credentials or tokens that were already present in those files. The
registrar requests owner-only permissions (`0600`) where the operating system
honors POSIX modes; Windows protection ultimately follows the directory ACL.
Only the newest 20 rollback points are retained, successfully rolled-back
backups are removed, and unresolved transactions are never pruned. Retention
cleanup runs after the state commit: a transient cleanup failure can leave extra
private backups for a later retry, but cannot turn a committed install or
relocation into a false failure. During an atomic host update, a private
same-directory CAS folder may briefly hold the displaced original bytes.
Protect both the registration directory and the host configuration directory
like the original config, and remove them when the installation is permanently
retired.

## Verification matrix

Configuration presence is necessary but not the final acceptance gate. After the host is restarted, verify discovery inside that host:

| Stage | Required evidence |
| --- | --- |
| Detect | Correct host and effective config path; HOME/config overrides honored |
| Register | Result is the host-specific `registered_pending_*` state or safe `adopted`; unrelated entries unchanged |
| Approve/reload | Only the target host completes its own approval or reload; Manager/tasks remain alive |
| Discover | Host's MCP list shows `eric-task-master` |
| Connect | MCP initialize succeeds and the server advertises its expected tools |
| Isolate | `TASKMASTER_CLIENT_ID` differs per host and contains no secret |
| Repeat | Second install is `registered` with no file or host-registry changes; activation still requires a live tool call |
| Remove | Only this installation's entry disappears |
| Interrupt | A `prepared`/`applying` journal is recovered on the next command, or fails closed without a write |
| Race | An edit injected after the last content assertion survives write, create, and remove attempts |
| Roll back | Per-host exact backup is restored, or a later edit produces a retryable safe conflict |
| Relocate | Wrong old root fails; exact old root preserves installation identity and updates only owned entries on the next install |

The repository tests simulate Windows, macOS, and Linux path-selection branches
in isolated fake homes, including spaces and Chinese characters. They also cover
cross-process serialization, compare-before-write conflicts, interrupted-journal
recovery, retryable rollback, symbolic-link rejection, retention, and explicit
relocation. These are branch simulations on the current test runner, not native
filesystem or live-host certification for all three operating systems. Native
Windows/macOS/Linux CI, real host discovery/restart, executable discovery, file
ACLs, and live `tools/list` acceptance still require explicitly authorized test
machines; a configuration-file check cannot prove that a live Agent loaded the
server.
