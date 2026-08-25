# Release gate

Task Master uses evidence gates rather than a blanket “commercial-grade” claim. A release is deliverable only when every local mandatory gate passes from a clean checkout and platform CI passes on each platform advertised as verified.

## Mandatory local gate

```bash
npm ci
npx playwright install chromium
npm run check
```

`npm run check` performs:

1. static version, dependency, pure-Playwright, Web Dashboard, launcher, and Skill-boundary checks;
2. serial unit, integration, security, registration, protocol, recovery, and real-browser tests;
3. real Chromium feature acceptance across Profile-owned fast/human/adaptive behavior, immutable engine policy, removed task overrides, persistent Profile open/close, click/input/select, upload/download, storage, screenshot, progress, checkpoint, artifacts, ephemeral isolation, user handoff, and cleanup;
4. a commercial acceptance workload with persistent Profile cleanup, bounded concurrency, same-Profile FIFO pressure, queued cancellation, browser timeout diagnostics, ephemeral zero-state verification, quiescence, and Manager restart history recovery.

Any failed assertion blocks release. The commercial workload report can be persisted with:

```bash
TASKMASTER_COMMERCIAL_REPORT=./release-evidence/commercial.json npm run acceptance:commercial
```

On PowerShell:

```powershell
$env:TASKMASTER_COMMERCIAL_REPORT = '.\release-evidence\commercial.json'
npm run acceptance:commercial
```

## Cross-platform boundary

The GitHub Actions matrix runs the same gate on Windows, macOS, and Linux. Local Windows success does not prove macOS. A platform becomes release-verified only after its own matrix job passes on the release commit. Until then it is “implementation audited / CI pending,” not “tested.”

Pushes to `upgrade/**` branches and pull requests run the same six-job matrix without publishing. After the candidate is reviewed and merged, the exact same-repository `main` push commit must pass all six jobs again.

Publishing is a separate manual action. Dispatch `.github/workflows/release.yml` with the exact 40-character `main` SHA and the package version only after local real-machine acceptance and explicit release approval:

```bash
gh workflow run release.yml \
  --repo npcworkspace-cmyk/eric-task-master \
  -f release_sha=<verified-main-sha> \
  -f confirm_version=<package-version> \
  -f confirm_immutable=true
```

Before dispatch, an authenticated repository administrator must verify Release immutability through the repository setting or its Administration API; the Actions token intentionally does not receive that administrator permission. The workflow requires that explicit confirmation, rejects a non-current `main` commit, a commit without a successful same-SHA `main` push CI, a mismatched package version, and any existing tag or Release. It creates a complete draft with the source, base Skill, and `SHA256SUMS`, publishes it once, and then verifies that GitHub reports the published Release as immutable. Published versions and assets are never replaced. Pull requests, candidate branches, forks, manual CI runs, failed gates, and non-`main` commits cannot publish.

## Faults covered

- Worker/action/task timeout and forced process cleanup;
- live heartbeat with stalled business progress;
- cancelled queued and active tasks;
- Profile lease contention and FIFO release;
- Manager restart with terminal history, interrupted task fail-closed handling, and explicit checkpoint resume;
- frozen-checkpoint consume-before-action/write/effect-resolution ordering and attempt-bound diagnostics;
- stable role/client ownership, reserved internal principal names, and cross-Agent task/artifact isolation;
- completion-result hiding, artifact hash anchors, and integrity checks on ordinary and idempotent replay paths;
- serialized task/manual-Profile lease renewal versus cleanup and authenticated graceful Manager shutdown;
- output/file-count exhaustion and link/path replacement attempts;
- missing, changed, hard-linked, or unstable artifacts;
- wrong/replayed Manager identity, role violations, and credential redaction;
- task-module inspection timeout/exit/error and transactional Task Pack conflicts;
- one-time Dashboard authorization and legacy session-import lease fail-closed migration.

## Honest boundary

No finite test suite proves stability on every website, OS build, browser update, network, account, or anti-abuse system. Core release evidence proves the runtime invariants and fixtures above. Platform-specific selectors, coverage, rate-limit ceilings, and account risk remain the responsibility of their specialized Skill/Task Pack and real-site acceptance.

Authenticated shutdown is verified. A power loss, operating-system kill, native browser failure, or trusted task that blocks the Node event loop can prevent Chromium descendant cleanup from being proved. In that case the runtime quarantines the Profile and retains cleanup evidence; it never signals a process solely from a persisted PID. Strict Windows hard-kill tree ownership would require a separately audited native Job Object guardian and is not claimed by this release.
