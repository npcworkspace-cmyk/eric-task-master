# Self-contained installers

Eric Task Master `v4.2.1` is distributed as a CLI-first Manager. Each platform package contains its own pinned Node.js runtime, the production dependency tree, the Manager, CLI, local Dashboard, matching driving Skill and optional online Codex CLI host adapter. Users do not install Node.js, npm, Playwright, or a Playwright browser. The optional decision adapter separately requires a supported installed and signed-in Codex CLI; that CLI and its account are not bundled.

Google Chrome is intentionally not redistributed. The Manager uses a locally installed stable Chrome channel and reports a direct installation instruction if Chrome cannot be found.

## Before deploying to another Agent

A working launcher means the Manager is already deployed, but not necessarily at version 4.2.1. Reuse a matching installation; replace an older one with Owner authorization, never by creating a second Manager or new Profile pool. If active work would be interrupted, ask the Owner to choose whether to wait or explicitly stop it.

One Manager installation and its Profile state are shared by Agents running as the same operating-system user. For a requested 4.2.1 deployment, read the actual version from `taskmaster --help` and `taskmaster manager status --json`: Skill version, launcher version and live Manager version are separate. A working older runtime is not a completed 4.2.1 deployment. Preserve its state and arrange the Owner-authorized replacement below; do not silently force-stop it or reinstall just to import a Skill. An already-running Agent host can retain an old PATH; retain and use the discovered absolute launcher rather than assuming a PATH update has taken effect.

Start every new deployment from [Latest](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest), not an old local archive or a historical release. For this release Latest must resolve to [v4.2.1](https://github.com/npcworkspace-cmyk/eric-task-master/releases/tag/v4.2.1). If a newer release is available, follow its matching deployment guide instead of pinning this older version; never silently downgrade. Download the runtime, Skill and `SHA256SUMS` from the same release and verify the digest before execution. The matching standalone guide is `eric-task-master-skill-v4.2.1.zip`, identical to `app/skills/eric-task-master/` inside a native/portable runtime. A Skill archive alone is not the application.

For new-Agent or Skill deployment on Windows, or when the assumed launcher fails, run `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '<SKILL_ROOT>/scripts/find-launcher.ps1'`. This read-only helper prefers a live Manager's verified embedded runtime, then the selected shared launcher, then the exact HKCU/HKLM uninstall record's `InstallLocation`, PATH and known portable extractions. The shared locator supplies the port when it is not the default. An unlocatable live Manager or damaged selected location remains `unresolved`; an older launcher is not a fallback. `%LOCALAPPDATA%\Programs\Eric Task Master` is only a fallback. Supply a known extraction with `-PortableRoot 'ABSOLUTE_DIRECTORY'`. The helper never executes a launcher, starts/stops Manager, or writes installation/state data. This is deployment discovery, not a mandatory preflight before ordinary tasks.

- `found`: execute the returned `launcher` with `--help` and read the live Manager version. If both are the requested 4.2.1, use that absolute path and import the matching Skill. If older, preserve the installation and complete the explicitly authorized upgrade before reporting deployment complete.
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

The Linux binaries use the official glibc Node.js builds and require glibc 2.28 or newer. Alpine/musl is not a supported `v4.2.1` target. Windows arm64 is not a native `v4.2.1` target. The two macOS packages are deliberately separate because Node.js publishes architecture-specific runtimes; they are not described as a universal binary.

## Install

Install stable Google Chrome first. Then use the package matching the operating system and CPU:

- Windows x64: open the `setup.exe`. Verify `taskmaster --help` in the terminal you intend to use, then run `taskmaster panel`. An old host can retain an inherited PATH even in a new terminal. The portable ZIP needs no installer; extract it and run `bin\\taskmaster.cmd`.
- macOS: run `sudo installer -pkg eric-task-master-v4.2.1-macos-<arch>.pkg -target /`, then run `taskmaster panel`. Because this release is unsigned, macOS may require explicit Owner approval.
- Debian/Ubuntu: run `sudo apt install ./eric-task-master-v4.2.1-linux-<arch>.deb`, then run `taskmaster panel`. The portable tarball can be extracted anywhere and started through `bin/taskmaster`.

Read `Eric Task Master 4.2.1` from the installed absolute launcher's `--help`. Confirm `manager status --json` and the installed Skill metadata both report 4.2.1. A recognized Windows replacement attempts activation automatically; otherwise, or if activation fails, complete the Owner-authorized replacement with that absolute launcher and `manager start --upgrade --json`. Copying application files alone does not establish activation. User data is created only when the Manager or another command starts.

## Portable ZIP fallback

Every target has `eric-task-master-v4.2.1-<target>-portable.zip`. Choose `windows-x64`, `macos-arm64` (Apple silicon), `macos-x64` (Intel), `linux-arm64`, or `linux-x64`. This is a complete Manager runtime, not the separate `eric-task-master-skill-v4.2.1.zip` instructions archive.

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

Before replacing a portable runtime, finish tasks, close Profile windows and explicitly stop its idle Manager with `manager stop --if-idle --json`. Extract the new tree into staging, then replace the prior application at its canonical path; do not merge the trees. Keep user Profiles and task data outside the application directory and retain a recoverable backup outside active command paths. Verify or retire other old portable launch paths before claiming replacement is complete. Installing or updating a same-version Agent Skill alone requires none of these runtime changes.

## Replacement upgrade and activation

The Windows replacement installer checks the old runtime and can stop the selected Manager automatically only when it is idle. When it is busy, the interactive installer asks the Owner to choose between waiting and explicitly stopping its tasks and Profile windows for replacement. A silent installation never chooses force; it stops and asks the calling Agent to obtain the Owner's decision. Other platforms require the calling Agent or Owner to make the same choice before replacement. An interrupted external action can have an unknown outcome; inspect it before retrying. Failed process inspection aborts without a force stop. The installer replaces only managed application payload; user state is never part of installer cleanup.

On Windows the installer recognizes the former sibling `<application directory> v3` when its recorded product identity is valid. It moves that whole old application to a recoverable backup and leaves a small forwarding launcher at the old path, so a process with an inherited old PATH reaches the current application. An unrecognized legacy folder, a newer installation or an in-use runtime stops the replacement; no arbitrary folder is removed. If the current installation is absent, the forwarding entry fails instead of running the backup.

After installing the new application, run its absolute launcher with `manager start --upgrade --json` under the same OS user. The new Manager synchronizes an existing selected Codex Skill from the same runtime before it reports ready, and the previous Skill is retained outside the active Skill directory. Check `manager.version` and `skill.state`: `current` or `replaced` means the selected installed Skill matches; `not-installed` means it still needs to be imported. A custom Skill location must be an absolute folder named `eric-task-master`, selected using `ERIC_TASK_MASTER_SKILL_DIR` for both activation and later commands. Do not claim a finished Agent upgrade without checking the selected Skill.

For a recognized Windows replacement, the native installer attempts this activation automatically after the application files are installed. An activation failure leaves the new application files in place, returns custom exit code 20, and reports that the upgrade is incomplete; resolve the condition and retry the explicit activation command. It does not stop an active task to force success. Other platforms and portable installations require the explicit activation command. A fresh installation without a selected Skill still requires importing it for an Agent.

The Manager rejects outdated client versions before creating or changing work. If the Manager and launcher match but a selected installed Skill is older, the current CLI quietly replaces that Skill from the bundle without stopping active work. For recognized Codex Agent sessions, or hosts identifying themselves with `ERIC_TASK_MASTER_AGENT_ID`, each Agent must read the new Skill and set `ERIC_TASK_MASTER_AGENT_SKILL_VERSION` for its own CLI calls before work can continue. An Agent refresh error means the rejected request was not executed. Safe stop and read controls remain available. This covers the default Codex Skill location or one explicitly selected location; a Manager cannot rewrite another host's in-memory instructions or identify an Agent that does not connect or identify itself. Verify each additional host separately and refresh its loaded Skill when needed.

Portable ZIP and tar users replace their canonical application tree rather than leaving old and new launchers active. Keep the separate user-state directory unchanged. Use the new absolute launcher for the authorized activation above; never use a new empty Profile or copied credentials to hide an upgrade error. Historical downloads and deliberately retained external copies cannot be remotely rewritten by a current installer.

## Runtime behavior

`taskmaster` always launches the Node binary inside the installation. The launcher clears inherited `NODE_OPTIONS` and `NODE_PATH` first, so preload hooks and module paths injected by an Agent host cannot enter the Manager or its Workers. Any CLI command can lazily start the loopback Manager, so Agent hosts do not register MCP tools and do not need a restart. Manager state and Chrome Profiles remain in the current user's Task Master home; application files are treated as read-only.

The installer never runs `npm`, `npx`, or a browser download. Build jobs set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and reject Playwright `.local-browsers` payloads. Every bundle contains `release-manifest.json`, an SPDX dependency inventory, the Node.js license, and third-party notices.

## Shared default and isolated data projects

Same-user Agents share one selected Manager and Profile pool by default. Different working directories do not create different default stores. On Windows, fresh state is `%USERPROFILE%\.eric-task-master\state`, outside virtualized AppData. `%USERPROFILE%\.eric-task-master\default-state.json` records the selected physical directory, port and optional launcher, never tokens. Existing state is reused in place, including a packaged host's legacy physical store; it is not silently moved or merged. If multiple cold legacy stores exist without a selection, startup reports `MANAGER_STATE_AMBIGUOUS` instead of choosing one or creating blank Profiles. An Owner may explicitly select the intended existing store with `manager start --state-dir ABSOLUTE_DIRECTORY --shared`.

For isolation, pass `--state-dir ABSOLUTE_DIRECTORY` on every command (or set `ERIC_TASK_MASTER_HOME`). Without an explicit port, the project selects a free loopback port and publishes it atomically. Windows AppData projects use a small shared location record outside AppData so packaged and unpackaged clients converge on the same physical project. Profile/task stores and lifetime locks remain per project. State beneath a replaceable application directory is rejected. Copied credentials cannot authorize controlling a different physical project; the CLI verifies physical identity and a nonce ownership proof before sending a token.

Normal `run` and `manager start` require a matching Manager version; normal use never silently stops a different version. `manager start --upgrade` refuses downgrades and synchronizes the selected installed Skill. When replacement would interrupt work, it reports the selected Manager and explicit wait/stop choices instead of deciding for the Owner. Safe stop and read controls remain available across a version mismatch.

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

## Unsigned `v4.2.1` boundary

The repository currently has no Apple Developer ID or Windows Authenticode signing secrets. Therefore `v4.2.1` packages produced by this workflow are explicitly marked `signed: false` in their manifests:

- Windows may display Microsoft Defender SmartScreen guidance.
- macOS may require the Owner to approve an unidentified developer package.
- Linux packages are direct-download artifacts rather than repository-signed packages; verify `SHA256SUMS` before installation.

Removing those warnings requires an Authenticode certificate for Windows and Apple Developer ID Application/Installer certificates plus notarization credentials for macOS. CI passing does not substitute for either signature. A future signed release must change the manifest and add post-signature verification; it must never silently reuse an unsigned tag.

## Uninstall and state

Uninstall application files only after an explicit `taskmaster manager stop --if-idle --json`. Windows and Linux refuse removal while the embedded runtime is in use; they never stop Agents automatically. Manual macOS application removal must also wait until the runtime is unused. User Profiles, cookies, task records and outputs are retained; purging state is a separate explicit Owner action.

On the next install/start, Manager reuses retained Profile metadata and directories in that state directory. Since 3.1.5, if `profiles.json` is missing or incomplete, valid retained v3 Profile directories are also re-listed automatically; directory-only entries receive a `Recovered profile_<id>` name. Choose the intended default again if its metadata is gone. Browser login files are preserved, although individual websites may still request verification. See [state backup and recovery](STATE-BACKUP-RECOVERY.md) for quarantine and scope limits.
