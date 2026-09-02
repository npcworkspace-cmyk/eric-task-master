# Release gate

Task Master uses evidence gates rather than a blanket “commercial-grade” claim. A release is deliverable only when every local mandatory gate passes from a clean checkout and platform CI passes on each platform advertised as verified.

## Mandatory local gate

```bash
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium
npm run check
```

`npm run check` performs:

1. static version, dependency, pure-Playwright, Owner Console, launcher, and Skill-boundary checks, including rejection of every removed external-cost runtime surface and agreement that only relevant visible unreadable/omitted/errored frames block scale while dense-main and hidden/decorative budget truncation remain warnings;
2. serial unit, integration, security, registration, protocol, recovery, and real-browser tests;
3. real Chromium feature acceptance across Profile-owned fast/auto/human behavior, mode-invariant humanized action topology with timing-only differences, Worker-confirmed live mid-task switching without restart, mandatory `full-human-v1` audits, immutable engine policy, removed task overrides, persistent Profile open/close, rendered-page traversal, curved pointer/click, keyboard input/select, continuous inertial scrolling and two-stream survey/backtrack, verified visible pagination, upload/download, storage, screenshot, progress, checkpoint, 10/10 interaction audit, artifacts, ephemeral isolation, user handoff, and cleanup;
4. a real-browser Owner Console acceptance that exercises the intentionally focused Tasks, Profiles, Task Packs, and Settings views plus the header verification drawer; creates/updates/opens/closes/deletes Profiles; verifies stable task names, Worker-confirmed configured/effective behavior with receipt time, live run/cooldown/total timing, bounded final-report rendering, cursor pagination, exact task-ID focus, and revision-checked batch pause/resume/cancel/delete controls; force-deletes a dead task with unconfirmed cleanup; searches, filters, selects, notes, deprecates, restores, safely deletes, and force-deletes executor assets; proves protected/live assets stay blocked, terminal task history survives forced asset detachment without resume, and every blocker can jump to the exact retained task; verifies notification claim/focus/continue, write-only Telegram/Feishu credentials, optional Feishu signing, native notification capability/settings/test state, settings-draft and pending-action race safety, immediate Chinese/English switching, and desktop/mobile layout; confirms removed Agent/raw-file/diagnostic/message surfaces are absent; checks 401 versus 403 handling; survives Manager restart; and validates responsive/keyboard/focus-trap/reduced-motion behavior;
5. a commercial acceptance workload with persistent Cookie/localStorage retention across task execution, manual Profile open-close, and Manager restart; bounded concurrency; same-Profile FIFO pressure; queued cancellation; browser timeout diagnostics; ephemeral zero-state verification; quiescence; and terminal history recovery.
6. an isolated backup-delete-restore drill that verifies the exact Manager identity, persistent Profile bytes and lease state, sealed resumable checkpoint, restored Manager authentication, real Worker resume, and final cleanup.

Any failed assertion blocks release. The commercial workload report can be persisted with:

```bash
TASKMASTER_COMMERCIAL_REPORT=./release-evidence/commercial.json npm run acceptance:commercial
```

On PowerShell:

```powershell
$env:TASKMASTER_COMMERCIAL_REPORT = '.\release-evidence\commercial.json'
npm run acceptance:commercial
```

On the release maintainer's machine, also exercise the locally installed stable Chrome engine before publishing:

```powershell
$env:TASKMASTER_ACCEPTANCE_PERSISTENT_ENGINE = 'chrome'
npm run acceptance:commercial
Remove-Item Env:TASKMASTER_ACCEPTANCE_PERSISTENT_ENGINE
```

Also run the isolated state recovery gate directly when investigating recovery changes:

```bash
npm run acceptance:backup-restore
```

The local command records the actual engine in its report. CI repeats this commercial workload on every advertised platform with the stable Chrome channel, while all ephemeral Profile checks continue to use the lockfile-pinned Chromium.

For a clean-Agent challenge that must not touch the user's normal `19946` Manager, isolate all state and choose a free loopback port. This is a release-maintainer path, not the normal onboarding protocol:

```powershell
$env:ERIC_TASK_MASTER_HOME = Join-Path $env:TEMP 'eric-task-master-isolated'
$env:ERIC_TASK_MASTER_HOST = '127.0.0.1'
$env:ERIC_TASK_MASTER_PORT = '29946'
node scripts/taskmaster.mjs connect --skip-mcp-registration --json
```

Verify the selected port is free first, use a fresh directory for every challenge, run only local fixtures, stop that isolated Manager through `manager stop`, and confirm its browser processes and listener are gone. Never reuse the production state directory or silently redirect normal users away from `19946`.

## Cross-platform boundary

The GitHub Actions matrix runs the same gate on Windows, macOS, and Linux and forces the persistent-Profile workload through each runner's stable Chrome channel; ephemeral work remains on the lockfile-pinned Chromium. Local Windows success does not prove macOS. A platform becomes release-verified only after its own matrix job passes on the release commit. Until then it is “implementation audited / CI pending,” not “tested.”

Pushes to `upgrade/**` branches and pull requests run the same six-job matrix without publishing. After the candidate is reviewed and merged, the exact same-repository `main` push commit must pass all six jobs again.

Publishing is a separate manual action. Dispatch `.github/workflows/release.yml` with the exact 40-character `main` SHA and the package version only after local real-machine acceptance and explicit release approval:

```bash
gh workflow run release.yml \
  --repo npcworkspace-cmyk/eric-task-master \
  -f release_sha=<verified-main-sha> \
  -f confirm_version=<package-version> \
  -f confirm_immutable=true
```

Before dispatch, enable Release immutability and configure `RELEASE_ADMIN_TOKEN` as a fine-grained repository secret with read-only Administration permission. The workflow uses it only to query GitHub's server-side immutability setting before creating a draft; a missing token, disabled setting, or unreadable setting fails before any Release exists. The normal Actions token performs publication. The workflow also requires explicit confirmation, rejects a non-current `main` commit, a commit without a successful same-SHA `main` push CI (including stable-Chrome acceptance), a mismatched or non-increasing package version, and any existing tag or Release. It creates a complete draft with the source, version-bound base Skill, matching MIT license, and `SHA256SUMS`, publishes it once, and then verifies that GitHub reports the published Release as immutable. Published versions and assets are never replaced. Pull requests, candidate branches, forks, manual CI runs, failed gates, and non-`main` commits cannot publish.

## Faults covered

- Worker/action/task timeout and forced process cleanup;
- live heartbeat with stalled business progress;
- cancelled queued and active tasks;
- Profile lease contention and FIFO release;
- Manager restart with terminal history, interrupted task fail-closed handling, Worker-exit checkpoint sealing, crash-receipt recovery, backdated terminal-replacement rejection, and explicit checkpoint resume;
- frozen-checkpoint consume-before-action/write/effect-resolution ordering and attempt-bound diagnostics;
- stable role/client ownership, reserved internal principal names, and cross-Agent task/artifact isolation;
- completion-result hiding, artifact hash anchors, and integrity checks on ordinary and idempotent replay paths;
- serialized task/manual-Profile lease renewal versus cleanup and authenticated graceful Manager shutdown;
- output/file-count exhaustion and link/path replacement attempts;
- missing, changed, hard-linked, or unstable artifacts;
- wrong/replayed Manager identity, role violations, and credential redaction;
- task-module inspection timeout/exit/error, direct-action bypass rejection, mandatory Task Pack Human Journey contracts, and transactional Task Pack conflicts;
- persistent Owner session bootstrap/restart/logout, exact-origin mutation protection, and Agent revoke/restore;
- task command idempotency/revision races, cooperative pause, cleanup-proved termination, cumulative cooldown timing, and tombstoned record deletion without idempotency replay;
- legacy session-import lease fail-closed migration.

## Honest boundary

No finite test suite proves stability on every website, OS build, browser update, network, account, or anti-abuse system. Core release evidence proves the runtime invariants and fixtures above. Platform-specific selectors, coverage, rate-limit ceilings, and account risk remain the responsibility of their specialized Skill/Task Pack and real-site acceptance.

Authenticated shutdown is verified. A power loss, operating-system kill, native browser failure, or trusted task that blocks the Node event loop can prevent Chromium descendant cleanup from being proved. In that case the runtime quarantines the Profile and retains cleanup evidence; it never signals a process solely from a persisted PID. Strict Windows hard-kill tree ownership would require a separately audited native Job Object guardian and is not claimed by this release.
