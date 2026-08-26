# Changelog

## 2.1.3 - 2026-08-26

- Made MCP the default multi-Agent integration: every host owns a scoped STDIO bridge while all bridges reuse one local Manager, shared Profiles, scheduling, and durable task state; CLI remains an emergency fallback only.
- Replaced the ambiguous native/needs-adapter model with explicit MCP capability, automatic-registration, configuration, and activation states without breaking the legacy response field.
- Promoted WorkBuddy Desktop to a verified adapter at `~/.workbuddy/mcp.json`, added no-write adoption for an exact existing installation, preserved host-managed metadata, and prohibited connector-proxy or approval-file changes.
- Added automatic adapters for CodeBuddy CLI and Gemini CLI, an official-command adapter for OpenClaw, and accurate first-party-extension or extension-required states for DSH and Pi; VS Code/Copilot and OpenCode remain explicitly adapter-pending instead of being misclassified as CLI-only.
- Expanded cross-platform registration, rollback, conflict, approval-boundary, official-command, multi-host identity, and MCP-first bootstrap checks while keeping HTTP/SSE MCP listeners out of the runtime.
- Added a real multi-host MCP protocol gate covering four independent STDIO bridges, one shared Manager, shared Profiles, scoped task data, Profile-aware scheduling, disconnect survival, and identity-stable reconnection.
- Hardened host registration against duplicate JSON/JSONC keys, reserved WorkBuddy path overrides, CodeBuddy registry precedence, OpenClaw process-tree leaks and unbounded output, shim indirection, metadata loss, disabled-entry misreporting, and human-text absence guesses; OpenClaw updates now preserve complete host metadata and use full-object CAS plus exact rollback.
- Persisted the registered runtime version so Manager migration and offline upgrades both require one Agent-host reload, and corrected version-mismatch recovery so an old bridge never tells the Agent to stop a newer Manager.

## 2.1.2 - 2026-08-26

- Reduced the Owner Console to two focused views: task progress and Profile management, with only pause, resume, cancel, and safe task-record deletion exposed for task control.
- Added immutable `Agent-task-createdAt` display names from stable host identity plus a bounded task label, eliminating per-task Agent-name confusion.
- Added Manager-derived execution, cumulative actual cooldown, and total elapsed timing, including interrupted cooldown accounting and live Dashboard updates.
- Added revision-checked logical deletion for cleanup-settled terminal task records while retaining private idempotency tombstones so completed external actions cannot be replayed after history is hidden.
- Standardized specialized Skill and Task Pack naming, input/output, and ownership conventions; new scaffolds use `<pack>.<verb>.v1` while legacy Pack identifiers remain compatible.

## 2.1.1 - 2026-08-26

- Replaced short-lived, Agent-scoped Dashboard sessions with one persistent local Owner Console at `http://127.0.0.1:19946/dashboard`; a one-time bootstrap link now establishes a hardened HttpOnly cookie that survives Manager restarts and can be explicitly revoked.
- Made every Profile a shared local resource while keeping task history, artifacts, reports, and command inboxes scoped to the Agent that started the work; legacy Profile ownership fields are migrated away without moving browser state.
- Added a durable Agent Registry with registered, online, offline, working, and revoked states, stable connection presence, current-task visibility, and Owner revoke/restore controls.
- Added revision-checked task pause, resume, terminate, modify, ask, command response, same-task continuation, timeline, and report publication; termination becomes final only after browser and Profile cleanup are proved.
- Rebuilt the Owner Console as a report-first human workbench for Agents, Profiles, tasks, progress, commands, and final reports, with responsive, keyboard, reduced-motion, retry, stale-state, and inline authorization handling.
- Added five preflighted Task Pack recipes—single page, paginated list, list-detail, resumable batch, and form workflow—plus task-type deprecation, replacement, and restoration lifecycle controls.
- Expanded the CLI and 21-tool MCP contract with durable Agent inbox, command acknowledgement, and report publication while retaining the fixed one-command bootstrap for new Agents.
- Added a real Manager + Playwright Owner Console acceptance gate to every local and cross-platform CI run, alongside the existing 30-check browser acceptance and 16-check stable-Chrome commercial workload.

## 2.0.1 - 2026-08-25

- Added one Agent-scoped CLI path for hosts without a native MCP adapter, reusing the signed Manager identity and existing durable task APIs instead of introducing another controller.
- Added fresh Dashboard-link creation, registered-only idempotent task start, bounded task waiting, and scoped Profile, task, recovery, and artifact commands for the CLI path.
- Rejected arbitrary module and credential-bearing inputs from the standard CLI task loop while retaining trusted local Task Pack and task-type authoring as explicit administrator surfaces.
- Completed the English, Chinese, base Skill, MCP-host, Profile, authoring, and Release-archive documentation so new Agents select one fixed MCP or CLI path without mixing identities.
- Kept task history created by the former v2.0.0 administrator CLI visible in the local Manager Dashboard; new CLI task records are intentionally visible only to their stable scoped Agent identity.

## 2.0.0 - 2026-08-25

- Replaced the browser extension and cross-browser session-transfer design with a pure Playwright runtime plus a same-origin Web Dashboard; users now sign in directly inside isolated persistent Profiles.
- Made browser engines immutable and fail-closed: persistent Profiles default to stable local Chrome with fixed human behavior, while ephemeral Profiles use pinned Chromium with Profile-owned fast, adaptive, or human behavior.
- Added signed ETMA2 Agent identities, Agent-owned Profiles/tasks, scoped one-time task Dashboard links, Agent/activity/progress visibility, and permission-preserving Dashboard sessions.
- Made task idempotency independent from mutable Profile policy while resolving the effective behavior at launch and recording it per attempt.
- Added persistent browser-state acceptance across task execution, manual Profile open-close, and Manager restart, alongside concurrency, queue, cancellation, timeout diagnostics, zero-state, and cleanup gates.
- Defined one simple Dashboard contract for Agents: every task start returns a clickable link, and an explicit “启动任务面板” request returns a fresh link without automatically opening a browser.
- Documented the trusted-local-Agent security boundary and global token-rotation model without claiming hostile multi-tenant isolation.

## 1.0.4 - 2026-08-25

- Reframed the English and Simplified Chinese project introductions around durable, unattended browser work for AI agents, with realistic production possibilities and naturally integrated GitHub discovery terms.
- Defined one non-divergent GitHub-to-task bootstrap and clarified that the portable Skill is an Agent instruction adapter while the complete cloned repository remains the runtime.
- Added authenticated, fail-closed migration from an idle older Manager; busy or unverifiable Managers remain untouched and return an actionable error instead of prompting Agents to invent another controller.
- Added integration coverage for successful idle migration and refusal to interrupt an older Manager with active work.
- Published the project under the MIT License so independent Skills, Task Packs, and commercial integrations can build on the core runtime.
- Made human-handoff state and its captured screenshot/semantic pointers one atomic Manager update, eliminating a slow-Windows observation race without weakening task deadlines.
- Kept valid diagnostics deliverable when Windows temporarily locks the recovery manifest, added bounded atomic-rename retry, and sized the commercial queue gate for four serial cold browser starts while preserving every task deadline.

## 1.0.3 - 2026-08-25

- Replaced automatic post-CI publication with an explicitly authorized manual Release that accepts an exact `main` SHA and confirmed version.
- Added candidate-branch CI for `upgrade/**` Playwright migrations without allowing candidates or pull requests to publish.
- Required a successful same-SHA `main` push CI, the current `main` head, administrator confirmation plus post-publication verification of GitHub Release immutability, and a previously unused tag/version.
- Removed Release asset replacement; new archives are attached to a draft and published once after all assets are present.
- Stabilized cross-platform acceptance timing without relaxing product deadlines, and made task-state timeout diagnostics report the last observed state and error code.

## 1.0.2 - 2026-08-24

- Made the full Windows, macOS, and Linux gate deterministic across Node.js 20 and 22 by removing cleanup-state timing assumptions and using portable extension and registration fixtures.
- Made manually opened Profile windows honor their configured headless mode, including Linux environments without a display server.
- Preserved a safe diagnostic-observation artifact when semantic inspection is transiently unavailable, so screenshot fallback never silently loses the reason or observation status.
- Upgraded CI to the current official Node 24-based GitHub Actions releases.
- Added gated CD: only a successful same-repository `main` push can publish exact-commit source, extension, and Skill archives with SHA-256 checksums as an immutable GitHub Release.

## 1.0.1 - 2026-08-24

- Hardened Manager shutdown, cleanup receipts, terminal-state handling, diagnostic screenshot delivery, session-import deadlines, public output budgets, and principal isolation after adversarial review.
- Expanded MCP image delivery, task durability, profile-worker, shutdown-proof, and real-browser acceptance coverage.
- Corrected the release version without rewriting the existing `1.0.0` release history.

## 1.0.0 - 2026-08-24

- Added task-scoped ephemeral Profiles for login-free work. Each run starts from a fresh isolated browser context, blocks service workers, persists no cookies or site storage, and closes automatically.
- Reworked `adaptive` behavior into visible fast, cautious, guarded, and cooldown states so ordinary work stays fast while ambiguity, failure, or rate limits trigger bounded protection without blind action replay.
- Added progressive task discovery, full contract-on-demand, transactional versioned Task Packs, and a portable scaffold for specialized Skills without adding site logic to the core.
- Added bounded semantic page observations, stable element references, cross-origin frame discovery, and automatic screenshot plus semantic evidence for timeouts, failures, stalls, and human handoffs.
- Added same-task `waiting_user` continuation so an Agent or user can inspect the live page and resume the existing Worker without restarting or duplicating uncertain actions.
- Added bounded FIFO scheduling across Profiles, same-Profile lease serialization, queue visibility, task cancellation, explicit cooldown countdowns, separate heartbeat/progress health, stall diagnosis, and fail-closed recovery.
- Expanded the extension and Dashboard to manage persistent and ephemeral Profiles, observe effective behavior, queues, cooldowns, stalled tasks, diagnostics, and continuation requests.
- Added a commercial acceptance gate covering real Chromium actions, session handling, ephemeral-state erasure, semantic observation, handoff, concurrent Profiles, queue pressure, cancellation, failure diagnostics, cleanup, and Manager restart persistence.
- Added Windows, macOS, and Linux CI across Node.js 20 and 22, plus a concise fixed-path base Skill and machine-safe MCP contracts for new Agents.

## 0.0.3 - 2026-08-24

- Upgraded `human` behavior with bounded curved pointer paths, safe in-target click positions, realistic press duration, per-character typing rhythm, punctuation pauses, eased scrolling, and explicit bounded reading dwell.
- Kept `fast` free of artificial delays and `adaptive` fast until a dynamic-page, failure, or rate-limit signal requests temporary human pacing.
- Added deterministic behavior tests and real Chromium event-trace acceptance for pointer, input, wheel, and reading mechanics.

## 0.0.2 - 2026-08-24

- Added a standard STDIO MCP server with scoped per-host Agent identities and durable task tools.
- Added transactional multi-host MCP registration, ownership, rollback, conflict detection, and relocation support.
- Replaced raw task module submission with verified task-type snapshots and persistent idempotency.
- Added declared, owner-scoped, bounded artifacts and removed local output paths from public responses.
- Added Manager auto-start from MCP, concurrent cold-start protection, and safe staging for disposable single-file task modules.
- Hardened extension pairing and Dashboard authorization with one-time approval codes and scoped expiring sessions.
- Expanded real Chromium acceptance to session transfer, all three behavior modes, upload/download, screenshots, progress, checkpoints, artifacts, and cleanup.
- Carried unresolved browser effects across task attempts and blocked new actions until trusted task logic records a verified observed outcome.
- Removed private CAS staging hardlinks immediately after host-configuration publication.
- Simplified `checkpoint.read()` to return the stored task data directly and documented idempotent output patterns for crash-safe resume.
- Reduced permanent extension host access to the exact loopback Manager origin; website access remains temporary and user-approved.
- Converted Manager task responses to an explicit public-field allowlist so future internal fields fail closed.
- Preserved declared artifact bytes exactly, retained failed browser actions as unknown until observed, recovered dead interrupted-task leases on resume, aligned extension request deadlines with Manager operations, and aborted task actions before timeout diagnostics.
- Added explicit, owner-scoped, idempotent checkpoint resume on the same durable task ID with preserved attempts and history.
- Added a Manager completion gate for result shape, declared artifact stability, browser closure, Worker exit, and Profile lease release.
- Made current-origin session import transactional: replace old destination state, verify it, and restore the exact prior origin snapshot on failure.
- Added per-task output budgets with bounded link-safe accounting and reserved diagnostic screenshot capacity; limits fail closed without deleting task output.
- Added a private metadata-only effect journal so interrupted actions remain inspectable without storing selectors, values, URLs, or credentials.

## 0.0.1 - 2026-08-23

- Created the independent Playwright-first Task Master runtime.
- Added persistent isolated Profiles with exclusive leases and a real-browser management extension.
- Added explicit current-origin Cookie and LocalStorage transfer without plaintext state files.
- Added fast, human, and adaptive task behavior modes.
- Added child-process task isolation, progress, heartbeats, checkpoints, diagnostics, outputs, cancellation, and cleanup.
- Added the local Dashboard, fixed Agent CLI, base Skill, version gate, and real Chromium acceptance suite.
