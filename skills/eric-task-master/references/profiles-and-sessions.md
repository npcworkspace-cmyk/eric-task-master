# Profiles and sessions

Each Task Master profile is a separate persistent Playwright `userDataDir`. One live lease is allowed per profile. Profile names are user-facing; immutable IDs are used by tasks.

## Login workflow

1. Ask the user to open the already signed-in site in their everyday Chromium browser.
2. The user opens the Task Master extension, chooses the destination profile, and clicks **Sync current site login**.
3. Wait for the panel to report the import result.
4. If the result is `manual_login_required`, open the destination profile and let the user sign in once there.
5. Submit the task only after the destination profile is ready.

The Agent may request a transfer but cannot approve it or access its contents. The extension transfers only the active origin after a user click. Some device-bound, passkey, certificate, session-storage, or server-revoked sessions cannot be migrated.

Before reading cookies or LocalStorage, the popup verifies a fresh nonce signature against the Manager identity pinned during pairing. It re-inspects the active tab and origin before reading and again before sending; any drift cancels the transfer. The optional origin permission used for that click is removed in `finally`, whether the import succeeds or fails.

The destination Profile must be idle. Import is a replace transaction, not a merge:

- Task Master snapshots the destination Profile's cookies visible to the selected origin, across their domain and path scopes, plus that origin's complete LocalStorage.
- It removes that selected-origin state before writing the approved bundle. Cookies for unrelated hosts and storage for unrelated origins are not changed.
- It verifies that no old selected-origin cookie or LocalStorage key remains. A `partial` result means the browser state replacement was verified but the site's account-level login was not; it does not mean that old and new accounts were merged.
- If writing or verification fails, Task Master restores the previous selected-origin snapshot before returning an error. `SESSION_IMPORT_ROLLBACK_FAILED` is a hard failure: do not run an authenticated task in that Profile until the user opens it and confirms the account or repeats the sync.

Session values stay in extension memory, Manager request memory, and the destination browser Profile only. They are never returned to the Agent, written to task logs, or stored in a transfer file. The importer closes its Playwright window and releases the Profile lease before the panel reports success.

Chromium normally discards session-only cookies when the importer closes. Task Master retains an explicitly transferred session-cookie copy inside the destination profile for at most 12 hours so the next task can reuse it. The site may invalidate it sooner; repeat the user-approved sync when required.

## Behavior defaults

- `fast`: minimum necessary Playwright waits; default for deterministic and data-heavy work.
- `human`: bounded hover, mouse, typing, reading, and scrolling cadence.
- `adaptive`: begins fast and slows after dynamic-page failures or rate-limit signals.

A task override wins over the profile default and is cleared during cleanup.
