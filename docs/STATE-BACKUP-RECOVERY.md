# State backup and recovery

The Task Master state directory contains the Manager Ed25519 identity, protected Manager credential, Profile registry and browser state, task records, checkpoints, task-type snapshots, notification settings, and Owner sessions. Treat the whole directory as sensitive authentication material.

## Backup rule

1. Stop Manager cleanly with `node scripts/taskmaster.mjs manager stop --json`.
2. Confirm no `.manager.lock` or `.manager.lock.recovery` remains.
3. Copy the entire state directory to an offline staging location without following symbolic links.
4. Hash every regular file and store a manifest beside the copy.
5. Encrypt the backup before it leaves the machine. Keep the encryption key elsewhere.
6. Restore only to the same absolute state-directory path. Profile and task records intentionally bind their private directories to that location.
7. Restore into an absent directory; never merge a backup into live or partial state.
8. Start Manager, verify its identity fingerprint, list Profiles, inspect resumable task checkpoints, and run one bounded resumed task before accepting recovery.

Do not back up a live Manager. A filesystem copy taken while task records, SQLite/Profile files, or checkpoints are changing is not a consistent recovery point.

## Automated release drill

```bash
npm run acceptance:backup-restore
```

The drill uses a new isolated temporary state directory. It starts a real Manager and Worker, creates a persistent Profile, interrupts a resumable task after a durable checkpoint, cleanly stops Manager, creates a file-by-file SHA-256 backup, deletes only that isolated source, restores it to the identical absolute path, and verifies:

- the Manager Ed25519 key pair and fingerprint are unchanged;
- Profile bytes, idle state, and lease state are intact;
- the sealed checkpoint hash is unchanged and remains resumable;
- the restored Manager authenticates normally;
- the real Worker resumes and reaches completed cleanup.

The drill never deletes the user's production state. Its purpose is to prove the supported recovery mechanism without gambling with live accounts. A release is blocked if any copy, hash, identity, Profile, checkpoint, resume, or cleanup assertion fails.
