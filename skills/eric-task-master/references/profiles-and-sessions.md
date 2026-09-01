# Profiles and sessions

Task Master has two Profile kinds. Profile names are user-facing; immutable IDs are used by tasks.

- `persistent` owns a separate Playwright `userDataDir` and is intended for login state or recurring work.
- `ephemeral` is a reusable task template, not a browser-data directory. Every task launches a fresh browser plus non-persistent context, blocks service workers, and destroys both during cleanup. It cannot be opened manually.

`browserEngine` is chosen once at creation and is never changed or automatically replaced after a launch error. Persistent defaults are stable local Chrome plus `human`; ephemeral defaults are pinned Chromium plus Profile-owned `auto` behavior. The Owner Console also stores whether an already-installed extension may run on the next persistent-Profile launch. Extensions require a visible persistent browser; headless mode and extension execution are mutually exclusive. Ephemeral Profiles never load extensions.

One live lease is allowed per Profile. Same-Profile tasks wait in FIFO order; different Profiles may run concurrently within the Manager budget. “Ephemeral / 隐身临时” means no local browser state survives the task. It does not claim fingerprint spoofing, anti-detection, CAPTCHA bypass, or immunity from platform controls.

Every Profile is a shared resource for all trusted local Agents connected to this Manager. There is no creator or per-Profile access list. One registered MCP client ID or one required stable CLI `--agent-id` remains a task principal: it attributes work and scopes that Agent's task records, artifacts, reports, and Owner-command inbox. A missing CLI ID fails closed. Profile leases, not creator identity, prevent browser-state collisions. This is coordination between trusted local processes, not a hostile tenant boundary; use separate operating-system users, sandboxes, or machines for mutually untrusted Agents.

## Login workflow

This workflow applies only to a `persistent` Profile.

1. Open the Owner Console URL returned by `connect` once. It silently establishes the persistent local Owner session; bookmark `http://127.0.0.1:19946/dashboard` for later use.
2. Create or select a persistent Profile and click **Open**.
3. Let the user complete login, OAuth, MFA, passkey, or account selection directly in that visible Playwright window. Manual open is always visible; `headless` applies only to task launches.
4. Close the Profile from the Owner Console and wait until it returns to `idle`, proving the browser closed and the lease was released.
5. Submit the task only after the Profile is ready.

To use a trusted browser extension, open that same persistent Profile, install and configure the extension manually through Chrome, close the Profile from the Owner Console, and enable **Allow extensions / 允许扩展运行** on its Profile card. The switch controls both later manual opens and Agent task launches. A change made while the Profile is open or leased is saved without restarting the current browser and applies after it closes. Task Master does not install extensions, enumerate them, move their data, copy their login state, or expose their storage to Agents.

## Extension action coordination

All Task Master runtime actions enter one Worker FIFO; a Journey step holds its slot through action, transition verification, and settling. Trusted extensions that implement `taskmaster-cooperative-v2` request and release the same FIFO lease for click, input, DOM, and navigation work and therefore have a strong serialization guarantee. Request IDs are idempotent per participant, grants carry both participant and request identity, a document navigation releases its lease, and lease expiry fails closed before another Task action starts. This bridge coordinates trusted participants but does not authenticate an extension: arbitrary third-party extensions cannot be forced to use it, and their page events cannot be reliably distinguished from ordinary site scripts. Operate an unintegrated extension only after pausing the task and observing `paused`; resume triggers page revalidation.

For manual extension work, pause the task and wait until its state is `paused`, perform the extension action, then resume the same task so the live page is revalidated. Do not operate an extension manually while the task is `running`. In an extension-enabled Profile, a legacy task may mutate the page only through its `action` facade; its `page` and `context` surfaces are observation-only. The task must still verify the result of any extension behavior that changes the page or network.

The persistent Profile's native Playwright `userDataDir` retains Cookie, LocalStorage, IndexedDB, service-worker, and other browser-managed state. Task Master does not copy credentials from another browser, expose them to an Agent, or maintain a parallel login-state vault. If a site logs out or rejects the state, reopen the same Profile and let the user sign in again there.

Only one live lease is allowed. The Dashboard cannot open a Profile while a task owns it, and a task waits while the user has its login window open. If cleanup cannot be proved, the Profile stays quarantined instead of being reused. For a persistent Profile whose owning task is already terminal and whose Worker is no longer live, the Owner Console may explicitly **Force-release lease**. Agents must not request or invoke this Owner recovery path. It preserves browser data, leaves the original task failed and cleanup-unconfirmed, and advances a lease fence so the stale Worker cannot renew. A possibly live owner makes the operation fail closed.

## Behavior defaults

- `fast`: the complete humanized action path with compressed central pacing.
- `human`: the same complete humanized action path at natural central pacing.
- `auto`: balances speed and caution, briefly becomes `cautious` for ordinary dynamic-page signals, and becomes guarded human-paced after occlusion, timeout, uncertain navigation, action failure, or rate limiting. Its effective mode and remaining guarded-action budget are visible in task status. Successful actions decay the temporary guard back toward fast.

Every mode keeps rendered traversal, curved pointer movement, target-safe clicks, per-character input, keyboard selection, continuous fine-frame wheel motion, and reading dwell; modes change only timing and guard depth. Static-page survey normally uses one continuous downward stream and one return stream, while far visible targets use one continuous approach. Behavior is selected on either Profile kind, and task start accepts no override. Updating it while a task owns the Profile uses a confirmed Manager-to-Worker control message: the current pacing delay is released and the new mode applies at the next scheduling or physical-action boundary, without a new Worker, browser, attempt, or task ID. A failed acknowledgement stops the task rather than letting it silently continue under the stale mode. Task status records `source: worker`, `confirmed: true`, and the Manager receipt time only after that acknowledgement. Site-required cooldowns remain authoritative.
