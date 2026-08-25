# Profiles and sessions

Task Master has two Profile kinds. Profile names are user-facing; immutable IDs are used by tasks.

- `persistent` owns a separate Playwright `userDataDir` and is intended for login state or recurring work.
- `ephemeral` is a reusable task template, not a browser-data directory. Every task launches a fresh browser plus non-persistent context, blocks service workers, and destroys both during cleanup. It cannot be opened manually.

`browserEngine` is chosen once at creation and is never changed or automatically replaced after a launch error. Persistent defaults are stable local Chrome plus fixed `human`; ephemeral defaults are pinned Chromium plus Profile-owned `adaptive` behavior.

One live lease is allowed per Profile. Same-Profile tasks wait in FIFO order; different Profiles may run concurrently within the Manager budget. “Ephemeral / 隐身临时” means no local browser state survives the task. It does not claim fingerprint spoofing, anti-detection, CAPTCHA bypass, or immunity from platform controls.

Every Profile is a shared resource for all trusted local Agents connected to this Manager. There is no creator or per-Profile access list. One registered MCP client ID or one required stable CLI `--agent-id` remains a task principal: it attributes work and scopes that Agent's task records, artifacts, reports, and Owner-command inbox. A missing CLI ID fails closed. Profile leases, not creator identity, prevent browser-state collisions. This is coordination between trusted local processes, not a hostile tenant boundary; use separate operating-system users, sandboxes, or machines for mutually untrusted Agents.

## Login workflow

This workflow applies only to a `persistent` Profile.

1. Open the Owner Console URL returned by `connect` once. It silently establishes the persistent local Owner session; bookmark `http://127.0.0.1:19946/dashboard` for later use.
2. Create or select a persistent Profile and click **Open**.
3. Let the user complete login, OAuth, MFA, passkey, or account selection directly in that visible Playwright window. Manual open is always visible; `headless` applies only to task launches.
4. Close the Profile from the Owner Console and wait until it returns to `idle`, proving the browser closed and the lease was released.
5. Submit the task only after the Profile is ready.

The persistent Profile's native Playwright `userDataDir` retains Cookie, LocalStorage, IndexedDB, service-worker, and other browser-managed state. Task Master does not copy credentials from another browser, expose them to an Agent, or maintain a parallel login-state vault. If a site logs out or rejects the state, reopen the same Profile and let the user sign in again there.

Only one live lease is allowed. The Dashboard cannot open a Profile while a task owns it, and a task waits while the user has its login window open. If cleanup cannot be proved, the Profile stays quarantined instead of being reused.

## Behavior defaults

- `fast`: optional speed-first policy for an ephemeral Profile and deterministic, data-heavy work.
- `human`: bounded hover, mouse, typing, reading, and scrolling cadence.
- `adaptive`: begins fast, briefly becomes `cautious` for ordinary dynamic-page signals, and becomes guarded human-paced after occlusion, timeout, uncertain navigation, action failure, or rate limiting. Its effective mode and remaining guarded-action budget are visible in task status. Successful actions decay the temporary guard back to fast.

Behavior is selected on the Profile. Persistent behavior cannot be patched, and task start accepts no override.
