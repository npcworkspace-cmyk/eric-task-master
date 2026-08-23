# Profiles and sessions

Each Task Master profile is a separate persistent Playwright `userDataDir`. One live lease is allowed per profile. Profile names are user-facing; immutable IDs are used by tasks.

## Login workflow

1. Ask the user to open the already signed-in site in their everyday Chromium browser.
2. The user opens the Task Master extension, chooses the destination profile, and clicks **Sync current site login**.
3. Wait for the panel to report the import result.
4. If the result is `manual_login_required`, open the destination profile and let the user sign in once there.
5. Submit the task only after the destination profile is ready.

The Agent may request a transfer but cannot approve it or access its contents. The extension transfers only the active origin after a user click. Some device-bound, passkey, certificate, session-storage, or server-revoked sessions cannot be migrated.

Chromium normally discards session-only cookies when the importer closes. Task Master retains an explicitly transferred session-cookie copy inside the destination profile for at most 12 hours so the next task can reuse it. The site may invalidate it sooner; repeat the user-approved sync when required.

## Behavior defaults

- `fast`: minimum necessary Playwright waits; default for deterministic and data-heavy work.
- `human`: bounded hover, mouse, typing, reading, and scrolling cadence.
- `adaptive`: begins fast and slows after dynamic-page failures or rate-limit signals.

A task override wins over the profile default and is cleared during cleanup.
