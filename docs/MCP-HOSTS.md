# MCP host registration

Eric Task Master does **not** depend on a fictional operating-system-wide MCP registry. The MCP protocol discovers tools only after a client has already connected to a server. This project therefore detects each installed host and merges the same local STDIO server into each host's own configuration.

The fixed server process is:

```text
<absolute Node.js path> <absolute project path>/src/mcp/stdio.mjs
```

Every native host entry receives only two non-secret identity values, mirrored
under the current `ERIC_TASK_MASTER_*` names and the compatibility
`TASKMASTER_*` names:

- `ERIC_TASK_MASTER_CLIENT_ID` / `TASKMASTER_CLIENT_ID` = `<installationId>:<hostKey>`
- `ERIC_TASK_MASTER_CLIENT_NAME` / `TASKMASTER_CLIENT_NAME` = `Eric Task Master / <host name>`

No Manager admin token, agent token, cookie, or browser credential is written to host configuration. The STDIO adapter obtains local Manager authority at runtime and exchanges it for a scoped Agent session.

## One command, separate host registrations

Run a preview first, then install:

```bash
node scripts/register-mcp.mjs install --dry-run --json
node scripts/register-mcp.mjs install --json
node scripts/register-mcp.mjs status --json
```

The result contains one record per host. Typical states are `registered_pending_restart`, `registered`, `not_installed`, `needs_adapter`, `conflict`, and `failed`. A host restart may be required; the registrar never kills or restarts an Agent, Manager, browser, or running task.

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

| Host | Registration surface | Default path / override | Automatic status |
| --- | --- | --- | --- |
| Codex app, CLI, IDE | `mcp_servers` TOML table | `$CODEX_HOME/config.toml` or `~/.codex/config.toml` | supported |
| Claude Desktop | `mcpServers` JSON object | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%/Claude/claude_desktop_config.json` | supported |
| Claude Code | user-scope `mcpServers` JSON object | `$CLAUDE_CONFIG_DIR/.claude.json` when overridden, otherwise `~/.claude.json` | supported |
| WorkBuddy Desktop | official writable user contract not yet verified for this release | installation hints only | `needs_adapter`, never modified |
| Hermes Agent | `mcp_servers` YAML mapping | `$HERMES_HOME/config.yaml` or `~/.hermes/config.yaml` | supported |
| DeepSeek Harness (DSH) | version-matched patch/plugin required | detected only | `needs_adapter`, never modified |
| Pi Coding Agent | MCP is extension/package-defined, not a core global registry | detected only | `needs_adapter`, never modified |
| OpenClaw | native CLI contract not yet accepted into this release | detected only | `needs_adapter`, never modified |

TaskMaster-specific path overrides are also available for controlled deployments and tests: `TASKMASTER_CODEX_CONFIG`, `TASKMASTER_CLAUDE_DESKTOP_CONFIG`, `TASKMASTER_CLAUDE_CODE_CONFIG`, `WORKBUDDY_MCP_CONFIG`, and `TASKMASTER_HERMES_CONFIG`.

The accepted adapters are based on the documented contracts for [OpenAI Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), [Claude Code MCP](https://code.claude.com/docs/en/mcp), and [Hermes MCP](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md). Documentation for [WorkBuddy/CodeBuddy MCP](https://www.workbuddy.cn/docs/cli/mcp), [DSH MCP examples](https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/mcp-memory/README.md), [Pi's coding-agent](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md), and [OpenClaw MCP](https://github.com/openclaw/openclaw/blob/main/docs/cli/mcp.md) is retained as adapter research only; those hosts are not modified until their writable user contract is verified end to end. The [MCP Registry FAQ](https://modelcontextprotocol.io/registry/faq) describes a public metadata registry, not local host registration.

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

JSON files are parsed and semantically merged. Invalid JSON/JSONC is rejected
without a write. TOML and YAML are changed only in the exact
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
| Register | Result is `registered_pending_restart`; unrelated entries unchanged |
| Restart | Only the target host is restarted manually; Manager/tasks remain alive |
| Discover | Host's MCP list shows `eric-task-master` |
| Connect | MCP initialize succeeds and the server advertises its expected tools |
| Isolate | `TASKMASTER_CLIENT_ID` differs per host and contains no secret |
| Repeat | Second install is `registered` with no file changes |
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
