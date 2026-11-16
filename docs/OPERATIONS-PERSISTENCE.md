# Incremental hot/cold operation evidence

Operations keep the same Manager/Worker permission and action contract. Storage writes changed hot records to a synchronized journal instead of rewriting every historical observation for each acknowledgement. Bulky, completed command replies are immutable content-addressed evidence, loaded only when requested. Other Task Master stores still use the existing `JsonStore`.

## Authoritative files

- `operations/operations.json` is a v3 checksummed snapshot envelope: format, store identity, sequence, chain head, initialization flag and hot materialized value.
- `operations/operations.journal.jsonl` is the synchronized, sequence-checked chain of changed fields and record indices after that snapshot.
- `operations/evidence/<sha256>.json` contains immutable canonical JSON replies referenced by terminal command records. A reference contains version, full SHA-256 and UTF-8 byte length; paths are derived only from validated hashes, never from user-provided filenames.
- Snapshot, journal and the entire evidence directory form one backup/restore unit. Both hot files are required after initialization, including when the snapshot sequence is zero. Copy or restore all three together while the selected Manager is stopped. A missing or damaged referenced evidence file fails closed; the runtime does not substitute an incomplete result.
- `operations/operations.legacy-v1.json` retains the original legacy bytes once. It is verified and synchronized before migration replaces the active snapshot. It is not the current state and is never automatically substituted for the journal.

The v3 envelope deliberately changes the format identifier and does not expose legacy top-level operation arrays. A v1 or v2 runtime must not silently ignore either journal entries or cold references and execute from stale/incomplete state. Do not downgrade a runtime against converted state. Profile identity and directories are not changed by this storage migration.

Migration accepts a valid legacy v1 document or valid v2 snapshot plus complete journal chain. The old chain is verified before the v3 snapshot is committed. Legacy v1 bytes are retained in the existing synchronized backup. Eligible inline replies are then written as durable evidence before one hot reference update, followed by snapshot-first compaction. Migration itself neither truncates replies nor applies terminal-record retention; interruption at the snapshot/journal handoff can be resumed without losing logical data.

The sequence and SHA-256 chain detect accidental corruption and mismatched files; they are not cryptographic authentication against a privileged editor who can rewrite state, evidence and every checksum.

## Hot state and full evidence

Only `command.reply` for `confirmed`, `failed` or `stopped` commands is eligible for cold storage, starting at 2 KiB of canonical JSON. Very small receipts remain inline. Pending/unknown command replies, current authorization, original command envelopes/fingerprints, every action, unresolved effect, global social duplicate key and action-limit evidence remain hot. Cold storage is not an authorization or decision cache.

`OperationsStore.read()` preserves the fully hydrated logical state and does not expose internal reply references. Trusted internal `project()` and update drafts deliberately return hot records, with `replyRef` rather than a bulky old reply. Runtime code explicitly calls `hydrateCommand(record)` or `hydrateCommands(records)` when returning the selected result or a full audit. Hydration restores exact replies, not summaries, with separate mutable objects for separate results. No large reply is automatically loaded for an authorization or scheduler read.

Read-only authorization projections omit unused actions. Other ordinary action authorizations retain every action for their operation, including cumulative/frequency-limit evidence; social replies retain cross-operation duplicate evidence. Every projection still applies the live snapshot/journal fences, and authorization is checked against current state, not a cached permission result.

Canonical record reuse is private and immutable. A changed nested value runs through sanitation again, and identical records do not accidentally share a mutable updater identity. Transaction canonical text/byte counts are computed once on a plain immutable graph, registered against that exact identity in a private WeakMap, and reused by journal validation. Callers cannot provide a different value with a stale or forged serialization proof.

## Evidence integrity and capacity

New evidence is sanitized before hashing. It is written to a private temporary file, synchronized and closed, linked to its final hash name without overwriting existing content, then verified and synchronized through the final name before the reference journal entry can commit. Existing files are verified by content, not trusted merely because their filename matches. An evidence write/sync/close/link failure yields no persistence acknowledgement and fences the store. A fully written but unreferenced immutable file is harmless retained evidence, not a committed command result.

Startup verifies every distinct referenced cold payload by full hash and byte length. Every actual cold hydration repeats that verification; missing, wrong-length or same-length-corrupt content fails closed and fences later hot reads/writes. Unrelated hot authorization/action reads do **not** rehash every historical cold file. Consequently an external deletion of unrequested old evidence is detected at its next hydration or restart, not necessarily immediately. Hot snapshot/journal changes retain their separate live fences on every projection/update.

Capacity remains the UTF-8 size of the complete logical state, including the full size of every retained cold reply, counted per command even when identical files are physically deduplicated. Limits are checked before creating new evidence, on each journal replay state, and on startup. Small hot references cannot bypass the existing logical storage bound or emergency pause reserve. Existing record/depth/array bounds and secret sanitation also apply before cold conversion.

There is no automatic evidence-file garbage collection or deletion. Replacing a reply or ordinary terminal-record retention can leave older immutable files; failed unacknowledged writes can also leave unreferenced files. The logical quota covers currently retained logical records, not every historical backup or orphan on disk. Physical storage management requires a separate explicit archival/cleanup procedure; disk-full failures are surfaced, not treated as acknowledgement.

## Acknowledgement and recovery

The journal entry is written and synchronized before persistence acknowledgement. Append, synchronization or close failure fences that live store. A fresh Manager validates the complete hash/sequence chain before recovering initiated effects as unknown; an uncertain effect is not permission to replay it.

When an idle Worker is already waiting, a newly reserved command and its delivered fence can share one synchronized entry. The same dispatch gate is held through the exact-wait resume acknowledgement; repeated command IDs do not acquire another delivery opportunity. Live authorization is checked again after the commit. A stale wait, denied dispatch or unconfirmed handoff is not permission to clear the fence or resend the command. The ordinary delayed-delivery path remains available when an idle wait cannot be captured.

An incomplete final line has not been acknowledged. Its bytes are retained in a uniquely named torn-tail evidence file before removing only that uncommitted suffix. A malformed complete line, sequence gap, checksum failure, missing initialized journal or external modification fails closed; it is not discarded as a harmless tail.

Compaction first atomically commits a snapshot with its current sequence/head, then resets the journal. Recovery verifies an old journal through the snapshot head and does not apply covered entries twice if interruption occurred between those steps. Materialized state and journal sizes remain bounded.

Explicit `effect:false` local UI preparation can buffer its completed or failed action receipts and commit them atomically with the command result. Each action still checks live authorization and before/after page identity. Default/explicit external effects, uploads, downloads, guarded transport and interactions retain their individual durable acknowledgements before execution. A conservative pre-action size budget falls back to that ordinary acknowledgement path for large receipts.

If the final command-result acknowledgement is lost, the Worker stops with `COMMAND_RESULT_UNKNOWN`: it does not retry the result, overwrite a potentially committed reply with `stopped`, or execute another command. Inspect the original command and actual application outcome; a delivered command with a dead Worker can require explicit Owner recovery or reconciliation, not automatic replay.

## Runtime consumers and verification scope

Read live operation evidence through `ops get` and paginated `ops events`, not by opening a second repair-capable store beside an active Manager. A raw secret scan must include both authoritative hot files and every file in the evidence directory. Historical backups can contain historical data and are not an automatically redacted export.

Fault-injection tests cover interrupted appends, synchronization/close acknowledgement loss, evidence-before-reference ordering, missing/corrupt cold files, logical capacity, v1/v2 migration, external edits, sequence/checksum failures and compaction boundaries. They do not establish physical disk/directory-entry or power-loss guarantees for every filesystem or device. Installation and public release require their own matching-version checks; a local source benchmark is not a deployment.
