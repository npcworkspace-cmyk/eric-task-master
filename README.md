# Eric Task Master 4.0

**Durable local Chrome execution for AI Agents.**

Let your Agent plan the work. Let Task Master keep the browser, task state, progress and results available beyond a single conversation turn.

Eric Task Master runs on your own computer. It gives terminal-capable Agents one CLI for finite browser jobs and persistent operations: submit a script, keep a selected Chrome Profile alive, wait for a condition or scheduled event, hand control to a person, and continue from recorded state. The Agent supplies judgment and business logic; Task Master supplies execution and lifecycle control. It is not a general-purpose autonomous Agent.

English | [简体中文](README.zh-CN.md) | [Download latest](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest) | [4.0.2 release notes](docs/releases/4.0.2.md) | [Task Master Skills](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill) | **[NPC Website ↗](https://www.npctech.site/)**

Built by **NPC**, a global PR and brand team with client-side experience—the creators of the Media Bridge media-resource platform and Task Master AI tool.

[Explore NPC ↗](https://www.npctech.site/) · [Media Bridge · npcpressbridge.com ↗](https://npcpressbridge.com/)

## Use your imagination

Task Master is useful when browser work has a clear goal, may take a while, and needs to retain its identity and results:

- Research and public-data collection that save useful results as they go.
- Repetitive browser jobs with script-owned pacing, checkpoints and result checks.
- Page monitoring that waits locally and raises an event when attention is needed.
- Authorized content, advertising or website workflows with scoped actions and explicit readback.
- Browser QA, downloads, archiving and reusable professional Skills.

These are workflow possibilities, not a promise of universal website compatibility. Each script or Skill defines the site-specific behavior and needs validation for its intended platform and authorization.

Codex, Claude Code, WorkBuddy, Hermes, Pi and other Agents that can run a local CLI and read JSON can use the same interface. No host-specific plugin, MCP registration or browser extension is required for the core runtime.

## Two execution modes

| Mode | Use it for | Lifetime |
| --- | --- | --- |
| `batch` | A finite group of actions or a one-off job | Finish when the bounded work is complete |
| `operations` | Repeated observation, commands, conditions and scheduled decisions | Keep the task and Chrome context available until stopped or a limit is reached |

An explicit mode in the task prompt applies only to that task and overrides the saved Profile default. Otherwise the Profile policy applies; `auto` selects from the declared Skill mode or waiting/follow-up intent, falling back to batch. `auto` is a selection policy, not a third execution engine.

**Human takeover is a pause lock, not a mode.** It preserves the browser and blocks automated mutation. Resume is explicit, stale targets are discarded, and unresolved effects must be reconciled first. Automation cannot release the takeover lock itself. Changing a mode never changes identity or permission.

## What 4.0 adds

### Persistent operations

Keep one task, Worker and Chrome context alive across bounded commands. Observe a selected region, use fresh page-bound targets, execute a small action group, verify the expected result, then wait. Local condition observers handle quiet waiting without requesting a model decision on every poll.

Ordinary `.mjs` jobs remain supported. They can use the bundled Playwright, CDP, HTTP, Node.js utilities, custom retries and checkpoints directly; the Manager does not impose website-specific task types or script registration.

### Scheduled events and explicit decisions

Schedules record time, timezone, allowed windows, expiry and run limits. Missed work follows a bounded misfire policy instead of replaying an unlimited backlog. Events distinguish **pending, delivered, received and handled**: delivery is not a decision or proof of a successful business action.

A live Agent can consume events through CLI long polling. An explicitly configured host adapter can deliver them to another process. The optional [online Codex CLI adapter](docs/CODEX-HOST-ADAPTER.md) invokes an independently installed, signed-in Codex CLI only for an event, with a persistent model-call budget. Its current decisions are limited to allowlisted **read-only observation or safe stop**—not publishing, sending messages or changing business records.

### Authorization, readback and recovery

Persistent operations bind permission to the selected browser/account, resources, origins, allowed actions and expiry. The Manager records an action before execution and durably acknowledges initiation before an effect. Readback determines whether the expected result is confirmed or unknown.

An uncertain write is not automatically retried. Reconcile the original expected result on the same authorized resource before deciding what to do next. The optional single-send transport adds narrow protection for known small same-origin JSON POST requests on explicitly selected Task Master Profiles. Neither it nor the action ledger guarantees universal exactly-once behavior in an external service.

See [Fast operations](docs/FAST-OPERATIONS.md) for schemas, command examples, transport limits and recovery rules.

## A small core, reusable workflows

```text
Agent + optional Skill
        │ plans, scripts, decisions
        ▼
taskmaster CLI → local Manager → Worker → selected Chrome Profile
                      │
                      ├─ task state, progress and result files
                      └─ operations, schedules and durable events

Human → local Dashboard → task control, Profiles and takeover
```

The Manager owns process lifetime, Profile leases, task state, progress, results and cleanup. Scripts and Skills own site behavior and business logic. Different Profiles can run concurrently; each Profile has one writer at a time. The Dashboard stays focused on Tasks and Profiles.

Submitted work can continue after an Agent turn ends **while the local computer and runtime remain running**. This does not promise execution through sleep, shutdown or a closed Agent host, nor automatic recovery of every browser session after a restart.

## Install 4.0.2

### 1. Locate an existing installation first

For a new Agent, **check for the Manager, install only if missing**. If the requested version is already deployed, **install/update only the Agent Skill**. Replace an older installation with authorization, not a second Manager or a replacement Profile pool; if work is active, let the Owner choose whether to wait or stop it.

To deploy or update through an Agent, give it the [latest release link](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest) and ask it to install or update Task Master and its matching Skill. The Agent should verify the release files and preserve existing state; if it cannot install or reload Skills in its host, it must report that limitation.

On Windows, use the Skill's [read-only launcher locator](skills/eric-task-master/scripts/find-launcher.ps1); on macOS/Linux, use the installed or known portable launcher. Verify the absolute launcher with `--help` and keep using that path. An unresolved location or state error is not permission to reinstall, merge state or recreate Profiles.

Agents running as the same OS user share one selected Manager and Profile pool by default. For an isolated project, explicitly pass `--state-dir ABSOLUTE_DIRECTORY` on every command. Normal startup reuses a matching running Manager; it does not silently replace a different version.

**An upgrade is complete only when the launcher, running Manager and installed driving Skill match.** An idle Manager can be stopped and replaced automatically. If it is busy, the Owner chooses whether to wait or explicitly stop its work and replace it; never force-stop by default. The new Manager synchronizes the selected installed Skill from its same-version bundle, retaining a backup. If the result says `not-installed`, import that Skill for the intended Agent. A nondefault Skill folder is selected with `ERIC_TASK_MASTER_SKILL_DIR`. Preserve existing Profiles, task records and outputs; see [installation](docs/INSTALLERS.md) and [state recovery](docs/STATE-BACKUP-RECOVERY.md).

The Manager rejects outdated clients before they create or change work. A recognized Agent whose Skill was refreshed must load the new instructions before retrying; each Agent acknowledges separately, while existing safe stop and read controls remain available. Installation alone is not activation. A known Windows `v3` launcher path is converted to a forwarding entry so an older terminal reaches the current installation; unknown or unsafe paths are not silently changed.

The Windows replacement installer attempts activation automatically; exit code 20 means the files were installed but activation is incomplete. Other packages and retries use the new absolute launcher with `manager start --upgrade --json`. Verify the running Manager and selected Skill rather than inferring completion from a successful file copy.

### 2. Download the matching runtime and Skill

For a new installation, install stable Google Chrome and choose files from the [latest release](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest) or the [versioned 4.0.2 release](https://github.com/npcworkspace-cmyk/eric-task-master/releases/tag/v4.0.2).

| Platform | Native installer | Portable ZIP |
| --- | --- | --- |
| Windows 10/11 x64 | `eric-task-master-v4.0.2-windows-x64-setup.exe` | `eric-task-master-v4.0.2-windows-x64-portable.zip` |
| macOS Apple silicon | `eric-task-master-v4.0.2-macos-arm64.pkg` | `eric-task-master-v4.0.2-macos-arm64-portable.zip` |
| macOS Intel | `eric-task-master-v4.0.2-macos-x64.pkg` | `eric-task-master-v4.0.2-macos-x64-portable.zip` |
| Debian/Ubuntu x64 | `eric-task-master-v4.0.2-linux-x64.deb` | `eric-task-master-v4.0.2-linux-x64-portable.zip` |
| Debian/Ubuntu arm64 | `eric-task-master-v4.0.2-linux-arm64.deb` | `eric-task-master-v4.0.2-linux-arm64-portable.zip` |

Also download **`eric-task-master-skill-v4.0.2.zip`**, `SHA256SUMS` and `UNSIGNED-BUILD.txt` from the same release. Verify checksums before installation. Windows and macOS packages are unsigned; portable ZIPs do not bypass SmartScreen or Gatekeeper.

The runtime includes Node.js, Playwright, the CLI, Dashboard, background Manager, same-version driving Skill and optional online Codex adapter. It uses your installed stable Chrome rather than bundling Chromium. A portable package needs no system Node.js or administrator installation; extract it to a permanent directory and use its launcher:

```powershell
# Windows portable example
& 'C:\Tools\eric-task-master\bin\taskmaster.cmd' panel
```

```bash
# macOS / Linux portable example
'/absolute/path/eric-task-master/bin/taskmaster' panel
```

### 3. Select the browser and give the Skill to your Agent

Open `taskmaster panel`. For ordinary script work, retain an existing Profile or create a named Profile, open its native Chrome window, sign in when needed, close the manual window and select the intended default. Do not replace an existing Profile to solve a discovery error.

**Signed-in account administration defaults to the user's explicitly selected real local browser through a supported browser-use adapter.** A supported local-browser adapter is not bundled. If unavailable, choose explicitly between connecting that selected browser through a supported adapter and authorizing a Task Master-owned Profile for this task. Never silently switch identity, attach an arbitrary browser or substitute another Profile.

Import the runtime's `app/skills/eric-task-master/` or `eric-task-master-skill-v4.0.2.zip` in the Agent's Skill manager. For folder-based installation, confirm `SKILL.md` is at the Skill root. Agents without a Skill manager can read [the driving Skill](skills/eric-task-master/SKILL.md) directly. Before declaring deployment complete, read back version 4.0.2 from Skill metadata, the absolute launcher's `--help`, and the running `manager status --json`.

## First batch task

Save a small, trusted `job.mjs`:

```js
export async function run({ page, input, outputDir, progress, signal }) {
  await page.goto(input.url, { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  await progress({ current: 1, total: 1, message: 'Collected title' });
  return { title, outputDir, aborted: signal.aborted };
}
```

Then use the verified launcher:

```bash
taskmaster run ./job.mjs --input '{"url":"https://example.com"}' --detach --json
taskmaster panel --json
taskmaster follow TASK_ID --wait-ms 60000 --json
taskmaster files TASK_ID --json
```

`run` starts the Manager when needed and returns a task ID. Continue later `follow` calls with the returned `after` cursor. `panel --json` returns the Dashboard link without opening another window. Omit `--profile` to use the chosen default for ordinary script work.

Only the submitted `.mjs` entry is frozen; sibling files are not automatically copied. Keep it self-contained or use explicit absolute resources. Save valuable data incrementally under `outputDir`, not only at completion.

## Start a persistent operation

Prepare a scoped `start.json` using the [operations guide](docs/FAST-OPERATIONS.md), including an explicitly selected browser, account/resource evidence, allowed actions and expiry. A configuration example does not itself authorize real-account work.

```bash
taskmaster ops start --input '@start.json' --json
taskmaster ops command OP_ID --input '@observe.json' --json
taskmaster ops get OP_ID --json
taskmaster ops events OP_ID --after CURSOR --wait-ms 30000 --json
taskmaster ops takeover OP_ID --json
taskmaster ops stop OP_ID --json
```

Commands return a durable reservation; read the matching reply before claiming completion. Preserve operation IDs and event cursors. After disconnects, inspect current state and unresolved actions before continuing. `ops stop-all` stops operations sessions only, not unrelated script jobs, and cannot undo effects already accepted by a service.

## Human verification and retained results

- A script can enter `wait({ reason: 'verification' })`. Chrome remains open; the runtime requests desktop notifications and takes bounded diagnostic screenshots. After 20 minutes it pauses and requires manual resume.
- The Agent or person judges the page. Task Master does not solve CAPTCHAs or assume a verification challenge has cleared.
- Finished task cards leave the Dashboard, but records and outputs remain available through the CLI until explicitly removed.
- **Clean space** preserves signed-in state, extension data and active work. Historical outputs are a separate opt-in deletion category.

## What has been demonstrated

The optional online Codex CLI adapter completed an isolated Windows four-hour acceptance window on 2026-11-15: **14,401,755.9 ms**, **238 samples**, maximum sampling gap **61.01 seconds**. Two new real CLI Agent calls produced a scoped observation after interrupted delivery and a safe stop refusing unauthorized publication. Idle adapter model calls were zero; no simulator business writes occurred, and isolated cleanup passed. The scheduled-entry assertion was reused from earlier evidence with unchanged adapter/core hashes; its elapsed time was not reused.

This is source-tree, online-host evidence. It does **not** establish original desktop-chat wakeup, recovery while the computer sleeps or the host is closed, real-platform business writes, or cross-platform installer success. Native package/portable verification and published asset checks are separate release gates. See [4.0.0 release notes](docs/releases/4.0.0.md) and [adapter evidence and limits](docs/CODEX-HOST-ADAPTER.md).

## Trust and safety boundaries

Task scripts are trusted local code running with the OS user's permissions, not a security sandbox. They can access the network and filesystem; run only Agents, Skills and scripts you trust. Operations safeguards do not turn arbitrary scripts into restricted code.

The Manager binds to `127.0.0.1`, redacts Manager-owned diagnostics and does not automatically replay an entire failed script. Review task-written files and screenshots before sharing. No mode, schedule, page instruction or adapter receipt can grant new authorization. Token/cost limits that depend on unavailable measurements must not be presented as enforced spend controls.

## Build and share Skills

The [Task Master Skills library](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill) hosts reusable workflow instructions, scripts and result checks. Skills are optional: start with a small script, validate the workflow, then share what proved useful.

Submit a [workflow idea](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/issues/new?template=skill-proposal.md) or follow the [contribution guide](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/blob/main/CONTRIBUTING.md). The runtime stays general; professional workflows evolve independently.

## License

MIT
