# Self-contained installers

Eric Task Master `v3.1.0` is distributed as a CLI-first Manager. Each platform package contains its own pinned Node.js runtime, the production dependency tree, the Manager, CLI, and local Dashboard. Users do not install Node.js, npm, Playwright, or a Playwright browser.

Google Chrome is intentionally not redistributed. The Manager uses a locally installed stable Chrome channel and reports a direct installation instruction if Chrome cannot be found.

## Release targets

| Target | Package | Installation scope |
| --- | --- | --- |
| Windows 10/11 x64 | `windows-x64-setup.exe` and portable ZIP | per user, under Local AppData |
| macOS Apple silicon | `macos-arm64.pkg` and portable ZIP | system installer or per-user extraction |
| macOS Intel | `macos-x64.pkg` and portable ZIP | system installer or per-user extraction |
| Debian/Ubuntu Linux x64 | `linux-x64.deb`, portable ZIP and tarball | system installer or per-user extraction |
| Debian/Ubuntu Linux arm64 | `linux-arm64.deb`, portable ZIP and tarball | system installer or per-user extraction |

The Linux binaries use the official glibc Node.js builds and require glibc 2.28 or newer. Alpine/musl is not a supported `v3.1.0` target. Windows arm64 is not a native `v3.1.0` target. The two macOS packages are deliberately separate because Node.js publishes architecture-specific runtimes; they are not described as a universal binary.

## Install

Install stable Google Chrome first. Then use the package matching the operating system and CPU:

- Windows x64: open the `setup.exe`. Start a new terminal after installation and run `taskmaster panel`. The portable ZIP needs no installer; extract it and run `bin\\taskmaster.cmd`.
- macOS: run `sudo installer -pkg eric-task-master-v3.1.0-macos-<arch>.pkg -target /`, then run `taskmaster panel`. Because this release is unsigned, macOS may require explicit Owner approval.
- Debian/Ubuntu: run `sudo apt install ./eric-task-master-v3.1.0-linux-<arch>.deb`, then run `taskmaster panel`. The portable tarball can be extracted anywhere and started through `bin/taskmaster`.

`taskmaster --help` is the installation check. User data is created only when the Manager or another command starts.

## Portable ZIP fallback

Every target has `eric-task-master-v3.1.0-<target>-portable.zip`. Choose `windows-x64`, `macos-arm64` (Apple silicon), `macos-x64` (Intel), `linux-arm64`, or `linux-x64`. This is a complete Manager runtime, not the separate `eric-task-master-skill-v3.1.0.zip` instructions archive.

1. Download the matching ZIP and `SHA256SUMS` from the same Release. Compare SHA-256 using `Get-FileHash` on Windows, `shasum -a 256` on macOS, or `sha256sum` on Linux.
2. Extract into a permanent, user-writable folder. Preserve the entire `eric-task-master/` tree, including `runtime/` and `app/`. On macOS/Linux, `unzip PACKAGE.zip -d DESTINATION` preserves the launcher's executable permissions.
3. Invoke the extracted launcher directly; it needs neither PATH setup nor a system Node.js installation:

   ```powershell
   & 'C:\Tools\eric-task-master\bin\taskmaster.cmd' panel
   ```

   ```bash
   '/absolute/path/eric-task-master/bin/taskmaster' panel
   ```

Use that same absolute launcher for `run`, `follow`, and other commands. No administrator access is needed for extraction or startup. Stable Chrome and the platform requirements above still apply. Unsigned binaries may still require OS approval; a ZIP does not bypass Gatekeeper or SmartScreen.

Before replacing or moving a portable runtime, stop its Manager with `manager stop --json`. Extract updates into a fresh application folder rather than merging files. User Profiles and task data remain in the separate Task Master user-state directory.

## Upgrading from 2.x

Run the v3 native installer over the existing managed installation. It first asks the previous Manager to stop cleanly, then replaces the application payload so removed MCP, registration, Task Pack, and other v2 files cannot remain beside v3. If the previous installation cannot be identified or stopped safely, the upgrade aborts instead of deleting it. The user-state directory is outside the application root and is never part of installer cleanup, so Profiles, login state, task records, and outputs remain in place.

Portable ZIP and tar users must replace the entire extracted `eric-task-master` directory rather than merge v3 files into an older directory. Keep the separate user-state directory unchanged.

## Runtime behavior

`taskmaster` always launches the Node binary inside the installation. The launcher clears inherited `NODE_OPTIONS` and `NODE_PATH` first, so preload hooks and module paths injected by an Agent host cannot enter the Manager or its Workers. Any CLI command can lazily start the loopback Manager, so Agent hosts do not register MCP tools and do not need a restart. Manager state and Chrome Profiles remain in the current user's Task Master home; application files are treated as read-only.

The installer never runs `npm`, `npx`, or a browser download. Build jobs set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and reject Playwright `.local-browsers` payloads. Every bundle contains `release-manifest.json`, an SPDX dependency inventory, the Node.js license, and third-party notices.

## Build commands

Run on the matching native target architecture:

```text
npm run build:bundle
```

That command detects the current operating system and architecture, stages and verifies the runtime, and invokes the native packager. The equivalent individual commands are:

```text
node scripts/build/stage-runtime.mjs --target <target> --out dist/stage/<target>
node scripts/build/verify-bundle.mjs --bundle dist/stage/<target>/eric-task-master
```

Then package with exactly one platform command:

```powershell
powershell -File scripts/build/package-windows.ps1 -StageRoot dist/stage/windows-x64 -OutputDir dist/release
```

```bash
bash scripts/build/package-macos.sh dist/stage/macos-arm64 dist/release
bash scripts/build/package-linux.sh dist/stage/linux-x64 dist/release
```

Windows packaging uses Inno Setup 6. macOS packaging uses Apple's `pkgbuild` and `ditto`. Linux packaging uses `dpkg-deb`, GNU tar, and `zip`. These are build-time tools only and are not required by the user.

## Desktop notifications

Verification waiting submits a system notification immediately and every 30 seconds, stopping on actual resume or automatic pause at 20 minutes. Windows uses WinRT with current-user AppUserModelID registration; portable launchers create the notification shortcut lazily on first use. macOS uses its built-in `osascript` notification command. Linux uses `notify-send` when available in the desktop session. OS notification permissions and focus settings control presentation; a missing helper or delivery failure does not block the task. `node scripts/acceptance-notifications.mjs --live` explicitly submits one real notification for local acceptance; routine CI uses deterministic clock and command-adapter tests.

## Verification boundary

CI must build on the target architecture, verify the pinned Node archive SHA-256, inspect the staged tree, install the native package, and run a disposable task that uses a bare `import { chromium } from 'playwright'` before uninstalling. This proves the installed Manager, bundled Node, Playwright module resolution, stable Chrome launch, task lifecycle, and native uninstaller together. Source acceptance separately exercises the complete Manager gate. The GitHub Linux arm64 runner does not preinstall Chrome, so that native job installs Google's official arm64 stable package solely for acceptance; Chrome is never copied into a Task Master artifact.

Local Windows acceptance proves the Windows package on the maintainer's machine. Native GitHub runners provide separate macOS and Linux evidence; Windows success is not presented as macOS/Linux success.

After native uninstall, each target also extracts its portable ZIP into a path containing spaces, verifies its payload hash and executable permissions, and invokes the extracted launcher with an isolated state directory. A real stable Chrome task must pass using bundled Node and Playwright, followed by verified Worker, Manager, Profile, and temporary-directory cleanup. This is separate evidence for the installer-free route.

## Unsigned `v3.1.0` boundary

The repository currently has no Apple Developer ID or Windows Authenticode signing secrets. Therefore `v3.1.0` packages produced by this workflow are explicitly marked `signed: false` in their manifests:

- Windows may display Microsoft Defender SmartScreen guidance.
- macOS may require the Owner to approve an unidentified developer package.
- Linux packages are direct-download artifacts rather than repository-signed packages; verify `SHA256SUMS` before installation.

Removing those warnings requires an Authenticode certificate for Windows and Apple Developer ID Application/Installer certificates plus notarization credentials for macOS. CI passing does not substitute for either signature. A future signed release must change the manifest and add post-signature verification; it must never silently reuse an unsigned tag.

## Uninstall and state

Uninstall application files only after `taskmaster manager stop --json`. Windows' uninstaller attempts this automatically; Linux/macOS package removal should be preceded by the command. User Profiles, cookies, task records, and task outputs are retained by default because deleting them is destructive. Purging the user state directory is a separate explicit Owner action.
