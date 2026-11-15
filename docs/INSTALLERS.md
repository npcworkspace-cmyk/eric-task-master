# Self-contained installers

Eric Task Master `v4.0.0` is distributed as a CLI-first Manager. Each platform package contains its own pinned Node.js runtime, the production dependency tree, the Manager, CLI, local Dashboard, matching driving Skill and optional online Codex CLI host adapter. Users do not install Node.js, npm, Playwright, or a Playwright browser. The optional decision adapter separately requires a supported installed and signed-in Codex CLI; that CLI and its account are not bundled.

Google Chrome is intentionally not redistributed. The Manager uses a locally installed stable Chrome channel and reports a direct installation instruction if Chrome cannot be found.

## Before deploying to another Agent

A working launcher means the Manager is already deployed, but not necessarily at version 4.0.0. Reuse a matching installation; upgrade an older one only through the explicit idle-only process, never by creating a second Manager or new Profile pool.

One Manager installation and its Profile state are shared by Agents running as the same operating-system user. For a requested 4.0.0 deployment, read the actual version from `taskmaster --help` and `taskmaster manager status --json`: Skill version, launcher version and live Manager version are separate. A working older runtime is not a completed 4.0.0 deployment. Preserve its state and arrange the explicit idle-only Owner upgrade below; do not silently stop it or reinstall just to import a Skill. An already-running Agent host can retain an old PATH; retain and use the discovered absolute launcher rather than assuming a PATH update has taken effect.

For this release select [v4.0.0](https://github.com/npcworkspace-cmyk/eric-task-master/releases/tag/v4.0.0), or confirm that [Latest](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest) resolves to that tag before claiming a 4.0.0 deployment. Download only matching `v4.0.0` assets and their `SHA256SUMS`; verify the digest before execution. Import `eric-task-master-skill-v4.0.0.zip`, or the identical `app/skills/eric-task-master/` inside a native/portable runtime. Do not point a deployment to an old local archive or substitute a different version without saying so.

For new-Agent or Skill deployment on Windows, or when the assumed launcher fails, run `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '<SKILL_ROOT>/scripts/find-launcher.ps1'`. This read-only helper prefers a live Manager's verified embedded runtime, then the selected shared launcher, then the exact HKCU/HKLM uninstall record's `InstallLocation`, PATH and known portable extractions. The shared locator supplies the port when it is not the default. An unlocatable live Manager or damaged selected location remains `unresolved`; an older launcher is not a fallback. `%LOCALAPPDATA%\Programs\Eric Task Master` is only a fallback. Supply a known extraction with `-PortableRoot 'ABSOLUTE_DIRECTORY'`. The helper never executes a launcher, starts/stops Manager, or writes installation/state data. This is deployment discovery, not a mandatory preflight before ordinary tasks.

- `found`: execute the returned `launcher` with `--help` and read the live Manager version. If both are the requested 4.0.0, use that absolute path and import the matching Skill. If older, preserve the installation and complete the explicitly authorized upgrade before reporting deployment complete.
- `unresolved`: existing registration/files/Manager or an uncertain query prevents confirming absence. Report the locator result; no deployment repair is authorized by this status. The helper exits with code 1 and `canFreshInstall: false`.
- `absent`: no registration, launcher, application directory, or reachable Manager was found and queries completed. A fresh install is appropriate only for a user-requested deployment; retained user-state data must still be preserved.

On macOS/Linux check `/usr/local/bin/taskmaster` or `/usr/bin/taskmaster`, known portable extractions, and the matching loopback health endpoint. A failed launcher or uncertain lookup is not confirmation of absence. `MANAGER_STATE_MISMATCH` means the caller and running Manager see different state; report the OS user, launcher, and the CLI's `error.details`: resolved `stateDir`, `port`, `expectedStateId`, `actualStateId`, `managerVersion`, and `stateChanged`. These are diagnostic fingerprints, not credentials. Use the CLI's observed identities instead of manually hashing a differently normalized path (Windows identity uses the lowercase resolved path). Do not install another Manager, overwrite `config.json`, or recreate Profiles as a troubleshooting step. A path failure alone does not authorize PATH/registry edits, state moves/deletions, or reinstalling; explicit repair work is a separate request.

## Release targets

| Target | Package | Installation scope |
| --- | --- | --- |
| Windows 10/11 x64 | `windows-x64-setup.exe` and portable ZIP | per user, under Local AppData |
| macOS Apple silicon | `macos-arm64.pkg` and portable ZIP | system installer or per-user extraction |
| macOS Intel | `macos-x64.pkg` and portable ZIP | system installer or per-user extraction |
| Debian/Ubuntu Linux x64 | `linux-x64.deb`, portable ZIP and tarball | system installer or per-user extraction |
| Debian/Ubuntu Linux arm64 | `linux-arm64.deb`, portable ZIP and tarball | system installer or per-user extraction |

The Linux binaries use the official glibc Node.js builds and require glibc 2.28 or newer. Alpine/musl is not a supported `v4.0.0` target. Windows arm64 is not a native `v4.0.0` target. The two macOS packages are deliberately separate because Node.js publishes architecture-specific runtimes; they are not described as a universal binary.

## Install

Install stable Google Chrome first. Then use the package matching the operating system and CPU:

- Windows x64: open the `setup.exe`. Start a new terminal after installation and run `taskmaster panel`. The portable ZIP needs no installer; extract it and run `bin\\taskmaster.cmd`.
- macOS: run `sudo installer -pkg eric-task-master-v4.0.0-macos-<arch>.pkg -target /`, then run `taskmaster panel`. Because this release is unsigned, macOS may require explicit Owner approval.
- Debian/Ubuntu: run `sudo apt install ./eric-task-master-v4.0.0-linux-<arch>.deb`, then run `taskmaster panel`. The portable tarball can be extracted anywhere and started through `bin/taskmaster`.

Read `Eric Task Master 4.0.0` from the installed absolute launcher's `--help`. After authorized start, confirm `taskmaster manager status --json` reports version `4.0.0`; a compatible old Manager may otherwise still be running. Confirm the imported Skill metadata is also `4.0.0`. User data is created only when the Manager or another command starts.

## Portable ZIP fallback

Every target has `eric-task-master-v4.0.0-<target>-portable.zip`. Choose `windows-x64`, `macos-arm64` (Apple silicon), `macos-x64` (Intel), `linux-arm64`, or `linux-x64`. This is a complete Manager runtime, not the separate `eric-task-master-skill-v4.0.0.zip` instructions archive.

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

Before replacing or moving a portable runtime, finish tasks, close Profile windows and explicitly stop its idle Manager with `manager stop --if-idle --json`. Extract updates into a fresh application folder rather than merging files. Keep user Profiles and task data outside the application directory. Installing or updating an Agent Skill requires none of these runtime changes.

## Upgrading existing 2.x or 3.x installations

Run the 4.0.0 native installer only after the Owner has explicitly stopped the idle Manager. The installer checks whether its embedded runtime is still in use and refuses rather than stopping any Agent. Failed process inspection also aborts. Once unused, it replaces only the managed application payload so removed files cannot remain. User state is never part of installer cleanup. Do not run an uncoordinated runtime update while Agents can start new work. Existing paths may retain a historical `v3` folder name; the actual launcher/manifest/live Manager version is authoritative, not the folder label.

Portable ZIP and tar users must extract the complete 4.0.0 tree into a fresh permanent application directory rather than merge files into an older directory. Keep the separate user-state directory unchanged. Use its absolute launcher for the explicitly authorized `manager start --upgrade --json`, then read back the running version; never use a new empty Profile or copied credentials to hide an upgrade error.

## Runtime behavior

`taskmaster` always launches the Node binary inside the installation. The launcher clears inherited `NODE_OPTIONS` and `NODE_PATH` first, so preload hooks and module paths injected by an Agent host cannot enter the Manager or its Workers. Any CLI command can lazily start the loopback Manager, so Agent hosts do not register MCP tools and do not need a restart. Manager state and Chrome Profiles remain in the current user's Task Master home; application files are treated as read-only.

The installer never runs `npm`, `npx`, or a browser download. Build jobs set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and reject Playwright `.local-browsers` payloads. Every bundle contains `release-manifest.json`, an SPDX dependency inventory, the Node.js license, and third-party notices.

## Shared default and isolated data projects

Same-user Agents share one selected Manager and Profile pool by default. Different working directories do not create different default stores. On Windows, fresh state is `%USERPROFILE%\.eric-task-master\state`, outside virtualized AppData. `%USERPROFILE%\.eric-task-master\default-state.json` records the selected physical directory, port and optional launcher, never tokens. Existing state is reused in place, including a packaged host's legacy physical store; it is not silently moved or merged. If multiple cold legacy stores exist without a selection, startup reports `MANAGER_STATE_AMBIGUOUS` instead of choosing one or creating blank Profiles. An Owner may explicitly select the intended existing store with `manager start --state-dir ABSOLUTE_DIRECTORY --shared`.

For isolation, pass `--state-dir ABSOLUTE_DIRECTORY` on every command (or set `ERIC_TASK_MASTER_HOME`). Without an explicit port, the project selects a free loopback port and publishes it atomically. Windows AppData projects use a small shared location record outside AppData so packaged and unpackaged clients converge on the same physical project. Profile/task stores and lifetime locks remain per project. State beneath a replaceable application directory is rejected. Copied credentials cannot authorize controlling a different physical project; the CLI verifies physical identity and a nonce ownership proof before sending a token.

Normal `run` and `manager start` reuse a compatible Manager without replacing its version. `manager start --upgrade` is explicit, idle-only and refuses downgrades. No new service, dependency or per-Agent deployment is required, and the normal one-command task path is unchanged.

An explicit Windows Owner upgrade also consolidates selected legacy AppData state once. Windows can expose a union of private packaged files and fallback files; a configuration file's physical parent alone may not contain every Profile. The upgrade must run from a host that reads the selected complete view. It copies and verifies the entire tree before publishing the new location, preserves credentials, IDs, names, defaults and the logical identity, and retains the original tree. Shared state goes to the shared home above; AppData projects go to separate keyed directories under `%USERPROFILE%\.eric-task-master\project-state`, while their requested `--state-dir` stays unchanged. Existing destinations are never overwritten or merged. Occupied or unverified Profiles block the copy. Normal startup refuses incomplete Profile rebasing with `MANAGER_STATE_UPGRADE_REQUIRED`; it never opens a blank replacement. This copy/hash work belongs only to explicit upgrade, never normal task or Agent startup.

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

## Unsigned `v4.0.0` boundary

The repository currently has no Apple Developer ID or Windows Authenticode signing secrets. Therefore `v4.0.0` packages produced by this workflow are explicitly marked `signed: false` in their manifests:

- Windows may display Microsoft Defender SmartScreen guidance.
- macOS may require the Owner to approve an unidentified developer package.
- Linux packages are direct-download artifacts rather than repository-signed packages; verify `SHA256SUMS` before installation.

Removing those warnings requires an Authenticode certificate for Windows and Apple Developer ID Application/Installer certificates plus notarization credentials for macOS. CI passing does not substitute for either signature. A future signed release must change the manifest and add post-signature verification; it must never silently reuse an unsigned tag.

## Uninstall and state

Uninstall application files only after an explicit `taskmaster manager stop --if-idle --json`. Windows and Linux refuse removal while the embedded runtime is in use; they never stop Agents automatically. Manual macOS application removal must also wait until the runtime is unused. User Profiles, cookies, task records and outputs are retained; purging state is a separate explicit Owner action.

On the next install/start, Manager reuses retained Profile metadata and directories in that state directory. Since 3.1.5, if `profiles.json` is missing or incomplete, valid retained v3 Profile directories are also re-listed automatically; directory-only entries receive a `Recovered profile_<id>` name. Choose the intended default again if its metadata is gone. Browser login files are preserved, although individual websites may still request verification. See [state backup and recovery](STATE-BACKUP-RECOVERY.md) for quarantine and scope limits.
