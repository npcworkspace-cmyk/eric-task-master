# State backup and recovery

The Manager state directory contains persistent Chrome Profiles, task metadata, partial outputs, and the local CLI token.

Back up only while Manager and Profile windows are closed:

```bash
taskmaster manager stop --if-idle
```

Copy the state directory with operating-system permissions preserved:

- Windows, new shared state: `%USERPROFILE%\.eric-task-master\state`
- macOS: `~/Library/Application Support/eric-task-master`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/eric-task-master`

Use `taskmaster manager status --json` to obtain `stateDirEffective`. After an explicit Windows Owner upgrade has consolidated legacy state, back up that complete physical directory. Before consolidation, a packaged host can expose fallback Profile files outside the configuration file's physical parent: back up the complete selected view from its original host, verify its configuration belongs to that Manager, and retain both source locations. Do not assume copying only the private LocalCache directory is complete. `manager start --upgrade` verifies and consolidates that view once without deleting its source; pass the same `--state-dir` for an isolated project. Keep the shared `default-state.json` and project location records under `%USERPROFILE%\.eric-task-master` with the backup. They contain locations, not credentials. Preserve `config.json` and Profile IDs/names/defaults together. Browser Profiles can contain logged-in sessions and must be encrypted at rest.

To restore, install the same major version, stop Manager, replace the state directory, then run:

```bash
taskmaster manager start
taskmaster status --json
```

Manager never kills a process from a persisted PID alone because the operating system may have reused that number. A lease with cleanup proof is reclaimed after its Worker is dead. Without cleanup proof, Manager waits for lease expiry and checks the exact `--user-data-dir`; an active or unreadable result stays quarantined, while a confirmed inactive Profile is recovered automatically.

If an uninstall left the `profiles/` directories but `profiles.json` is missing or incomplete, Manager 3.1.5 and later re-registers every direct child with a valid v3 Profile ID on startup. Existing names and the default are preserved when their metadata remains. A Profile known only by its directory appears as `Recovered profile_<id>`; its former display name and default cannot be inferred, so select the intended default explicitly in the Dashboard. Login files are not moved or rewritten. Active Chrome use or an uncertain process probe keeps the Profile visible but quarantined until inactivity can be confirmed. This scans only the current state directory, not other users' homes or arbitrary old installations. Back up the state directory before any manual repair; a malformed `profiles.json` still requires deliberate recovery rather than automatic replacement.

Tasks that were active during an unclean Manager shutdown become `error`; their existing output files remain available. Task scripts that need restartable work should write their own checkpoints incrementally under `outputDir`.

## If state changes while Manager is running

Changing only the local token is picked up automatically. No browser login or Agent host restart is required. Manager also detects ordinary external replacement of its task and Profile metadata using file identity; these checks do not make a live directory restore safe.

When it detects a replaced state, it stops accepting work and writing old metadata. The CLI reloads an idle Manager automatically. If the old Manager still owns running/waiting tasks or an open Profile, it reports `MANAGER_BUSY`. To explicitly stop those old processes and reload the current state:

```bash
taskmaster manager recover --json
taskmaster status --json
```

Recovery keeps existing outputs and login data. Interrupted scripts must continue from checkpoints in a new task; former in-memory execution cannot be resumed. If process cleanup cannot be confirmed, recovery reports the reason and can be retried. Use the same `--state-dir` on every isolated-project command; its port is discovered automatically unless explicitly supplied. A different project cannot take over that Manager. `MANAGER_STATE_AMBIGUOUS` requires selecting the intended existing store explicitly, not merging or replacing its data.

Versions before 3.1.3 do not implement this recovery protocol. If an older running Manager already has stale credentials, close that Manager and its task windows (or restart the computer), then update and start Manager again. Keep the existing state directory. The newer CLI reports this case as `LEGACY_MANAGER_RESTART_REQUIRED` from `manager recover`, instead of claiming recovery succeeded.
