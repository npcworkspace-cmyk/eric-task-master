# 1.0 release gate

Task Master uses evidence gates rather than a blanket “commercial-grade” claim. A release is deliverable only when every local mandatory gate passes from a clean checkout and platform CI passes on each platform advertised as verified.

## Mandatory local gate

```bash
npm ci
npx playwright install chromium
npm run check
```

`npm run check` performs:

1. static version, dependency, Manifest V3, pure-Playwright, icon, launcher, and Skill-boundary checks;
2. serial unit, integration, security, registration, protocol, recovery, and real-browser tests;
3. real Chromium feature acceptance across fast/human/adaptive behavior, session import, click/input/select, upload/download, storage, screenshot, progress, checkpoint, artifacts, ephemeral isolation, user handoff, and cleanup;
4. a commercial acceptance workload with bounded concurrency, same-Profile FIFO pressure, queued cancellation, browser timeout diagnostics, ephemeral zero-state verification, quiescence, and Manager restart history recovery.

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

## Faults covered

- Worker/action/task timeout and forced process cleanup;
- live heartbeat with stalled business progress;
- cancelled queued and active tasks;
- Profile lease contention and FIFO release;
- Manager restart with terminal history, interrupted task fail-closed handling, and explicit checkpoint resume;
- output/file-count exhaustion and link/path replacement attempts;
- missing, changed, hard-linked, or unstable artifacts;
- wrong/replayed Manager identity, role violations, and credential redaction;
- task-module inspection timeout/exit/error and transactional Task Pack conflicts;
- extension session-transfer drift, permission revocation, rollback, and cleanup.

## Honest boundary

No finite test suite proves stability on every website, OS build, browser update, network, account, or anti-abuse system. Core release evidence proves the runtime invariants and fixtures above. Platform-specific selectors, coverage, rate-limit ceilings, and account risk remain the responsibility of their specialized Skill/Task Pack and real-site acceptance.
