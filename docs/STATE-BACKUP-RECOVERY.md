# State backup and recovery

The Manager state directory contains persistent Chrome Profiles, task metadata, partial outputs, and the local CLI token.

Back up only while Manager and Profile windows are closed:

```bash
taskmaster manager stop
```

Copy the state directory with operating-system permissions preserved:

- Windows: `%LOCALAPPDATA%\eric-task-master`
- macOS: `~/Library/Application Support/eric-task-master`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/eric-task-master`

If `ERIC_TASK_MASTER_HOME` is set, that explicit path is the state directory. Browser Profiles may contain logged-in sessions and must be encrypted at rest.

To restore, install the same major version, stop Manager, replace the state directory, then run:

```bash
taskmaster manager start
taskmaster status --json
```

Manager never kills a process from a persisted PID alone because the operating system may have reused that number. A lease with cleanup proof is reclaimed after its Worker is dead. Without cleanup proof, Manager waits for lease expiry and checks the exact `--user-data-dir`; an active or unreadable result stays quarantined, while a confirmed inactive Profile is recovered automatically.

Tasks that were active during an unclean Manager shutdown become `error`; their existing output files remain available. Task scripts that need restartable work should write their own checkpoints incrementally under `outputDir`.

## If state changes while Manager is running

Changing only the local token is picked up automatically. No browser login or Agent host restart is required. Manager also detects ordinary external replacement of its task and Profile metadata using file identity; these checks do not make a live directory restore safe.

When it detects a replaced state, it stops accepting work and writing old metadata. The CLI reloads an idle Manager automatically. If the old Manager still owns running/waiting tasks or an open Profile, it reports `MANAGER_BUSY`. To explicitly stop those old processes and reload the current state:

```bash
taskmaster manager recover --json
taskmaster status --json
```

Recovery keeps existing outputs and login data. Interrupted scripts must continue from their saved checkpoints in a new task; their former in-memory execution cannot be resumed. If process cleanup cannot be confirmed, recovery reports the reason and can be retried. A CLI pointing at another state directory must use the matching `--state-dir` and `--port`; it will not take over that Manager.

Versions before 3.1.3 do not implement this recovery protocol. If an older running Manager already has stale credentials, close that Manager and its task windows (or restart the computer), then update and start Manager again. Keep the existing state directory. The newer CLI reports this case as `LEGACY_MANAGER_RESTART_REQUIRED` from `manager recover`, instead of claiming recovery succeeded.
