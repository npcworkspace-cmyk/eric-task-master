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
