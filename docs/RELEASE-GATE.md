# Release gate

Eric Task Master publishes only artifacts that were built and exercised by CI from the exact commit being released. For new publication, a green branch, pull request, manual run, older `main` commit, or different commit is not release evidence.

## Required evidence for one commit

The candidate must be the current 40-character `main` SHA. That same SHA must have two separate successful `push` workflow runs:

1. `.github/workflows/ci.yml` (`cross-platform-release-gate`);
2. `.github/workflows/codeql.yml` (`code-scanning`).

The release workflow looks up both runs by workflow, `main`, and `push`, then verifies their returned `head_sha`, `head_branch`, event, status, and conclusion. If either proof is absent or unsuccessful, it exits before creating a tag, draft, or Release.

## Cross-platform CI

Every CI job runs `npm run check`, stages a self-contained Manager with bundled Node.js and production dependencies, verifies that no Chromium payload was bundled, installs the native package, starts and exercises a real stable Chrome task, and uninstalls it. The five required jobs and uploaded artifact names are:

| Target | GitHub runner | CI artifact |
| --- | --- | --- |
| Windows x64 | `windows-2025` | `release-windows-x64` |
| macOS Apple silicon | `macos-15` | `release-macos-arm64` |
| macOS Intel | `macos-15-intel` | `release-macos-x64` |
| Linux x64 | `ubuntu-24.04` | `release-linux-x64` |
| Linux arm64 | `ubuntu-24.04-arm` | `release-linux-arm64` |

Each job also extracts the target's portable ZIP after native uninstall, then runs its launcher and a real Chrome task using bundled Node in isolated state. Payload hashes, POSIX executable permissions, paths containing spaces, host Node environment isolation, and process/Profile cleanup must pass.

Each artifact contains its native packages, portable ZIP, bundle manifest, SPDX inventory, target checksum file, and acceptance evidence. The CI workflow runs for `main`, version branches matching `v*` (including `v3.0.0`), and `upgrade/**` pushes, all pull requests, and manual diagnostics. Only a successful `main` **push** run is eligible for release.

## Publication

Dispatch `.github/workflows/release.yml` with the exact current `main` SHA, the matching package version, and both explicit confirmations:

```bash
gh workflow run release.yml \
  --repo npcworkspace-cmyk/eric-task-master \
  -f release_sha=<40-character-current-main-sha> \
  -f confirm_version=<package-version> \
  -f confirm_unsigned=true \
  -f confirm_immutable=true
```

The workflow downloads `release-*` from the proven CI run; it does not rebuild the native Manager packages. It checks every manifest against the requested version and SHA, creates the small Agent Skill archive, regenerates `SHA256SUMS`, and revalidates current `main`, both exact workflow runs, release immutability, and tag absence immediately before publication. A `RELEASE_ADMIN_TOKEN` secret with read-only repository Administration access is required to verify the immutable-release policy. Published versions and assets are never replaced.

## Read-only verification of an existing Release

If publication succeeded but its final verification failed, do not republish or replace that version. Dispatch the same workflow with `verify_existing=true`, `release_sha=<original-release-sha>`, and `confirm_version=<published-version>`. The two required publication confirmation inputs can be `false` in this mode; no publication is attempted:

```bash
gh workflow run release.yml \
  --repo npcworkspace-cmyk/eric-task-master \
  -f release_sha=<40-character-original-release-sha> \
  -f confirm_version=<published-version> \
  -f confirm_unsigned=false \
  -f confirm_immutable=false \
  -f verify_existing=true
```

This separate job has only `contents: read` and `actions: read` permissions. It never creates, edits, deletes, or uploads a Release.

The original SHA need not still be current `main`, but it must have successful exact-SHA `main` push CI and CodeQL runs. Verification resolves `refs/tags/v<version>` explicitly so a same-name branch cannot shadow the tag, requires the published Release to be immutable, downloads its original CI artifacts, and recreates only the Skill ZIP and checksums using the original source and archive timestamp. Every published filename and SHA-256 (including `SHA256SUMS`) must match. Missing or expired original CI artifacts fail verification rather than silently rebuilding installers or weakening the proof. New publication remains the default (`verify_existing=false`) and retains every current-main gate above.

## Signing boundary

Windows and macOS packages are currently unsigned, macOS is not notarized, and Linux packages are not repository-signed. Every Release must include `UNSIGNED-BUILD.txt`, SPDX inventories, manifests, and `SHA256SUMS`. Windows Authenticode, Apple Developer ID/notarization, and Linux repository signing require future platform credentials; neither CI nor documentation may claim them before those credentials and verification steps exist.
