# Changelog

## 2.8.0 - 2026-08-29

- Added bounded cursor pagination and revision-checked batch pause, resume, cancel, and safe task-record deletion to the Owner Console. Task Pack deletion blockers now identify the exact retained task to Owner clients and can load, select, and highlight that task without exposing cross-owner task IDs through Agent MCP inventory.
- Added a dedicated bilingual Settings view for native operating-system, Telegram Bot, and Feishu/Lark human-verification notifications. Settings drafts survive background polling, all save/test/clear operations are serialized, capability and last-test states remain visible, Feishu signing is optional and write-only, and supported hosts can open their system notification settings.
- Hardened native Windows notifications with a registered application identity and protocol activation back to the exact task. Registration-only setup now exits before probing the Windows toast runtime, preventing hidden initialization from stalling the Manager or its acceptance suite. Human-verification alerts remain the only automatic notification class, fire immediately, repeat every 30 seconds, and stop after the Owner claims or resolves the matching request.
- Added a bounded public Task Pack failure contract with stable categories, codes, safe field details, type diagnostics, and one recovery action. MCP preserves this allowlisted contract and correlated request IDs while arbitrary exception text, paths, credentials, and provider payloads remain private.
- Refined semantic frame evidence so visible unreadable or omitted frames still block scaling, while a dense main document or hidden/decorative child that merely reaches the observation budget becomes a warning after a bounded challenge scan. This removes false blockers without weakening challenge detection.
- Removed the generic paid-provider budget, ledger, runtime facade, Worker IPC, and MCP/HTTP inputs. New declarations fail closed; legacy paid task history remains readable after private migration but cannot start or resume. Provider authorization and cost governance now remain wholly outside the site-agnostic core.
- Expanded static, migration, notification, cross-language, task-history pagination, batch-control, blocker-navigation, responsive, accessibility, real Chromium, and red-team acceptance coverage for the four-view Console and the 2.8.0 protocol surface.

## 2.7.0 - 2026-08-29

- Added durable human-verification alerts through the native operating-system channel, Telegram Bot, and Feishu/Lark webhook. Alerts are created only for an explicit `human_verification` handoff, fire immediately, repeat every 30 seconds, and stop after the Owner claims or resolves that exact request; ordinary failures, stalls, cooldowns, cleanup, completion, and login ambiguity never notify.
- Added a compact bilingual notification drawer to the existing three-view Owner Console. Chinese/English switching is immediate and persists only the language preference; notification credentials stay write-only and server-side. Claiming a verification focuses the live task window without continuing it, while “verification complete” revalidates and continues the same task.
- Revalidated persisted alerts against live task state before delivery, serialized claim/continue transitions, rejected Agent continuation before an Owner claim, removed the ordinary short handoff deadline from human verification, and added explicit Telegram/Feishu credential clearing. Temporary eligibility/storage failures retain the alert for the next cycle; TaskService remains authoritative if notification-state synchronization degrades after claim, continue, or cancel.
- Made same-task continuation a Worker-acknowledged protocol instead of treating an IPC enqueue as success. The live waiter now resumes before optional progress reporting, missing or rejected acknowledgements fail closed within five seconds without consuming the pending request, advanced Worker state is never regressed, and acceptance timeouts expose the last state, health, handoff, cleanup, and error summary.
- Hardened paid-Pack budgets into durable at-most-once execution grants, sealed the final checkpoint generation before Worker-exit cleanup becomes observable, carried that seal in crash-recovery receipts, fairly reserved semantic-observation capacity across frames, and paginated the MCP Task Pack inventory. Terminal reads and asset checks only verify the immutable seal and never adopt a backdated replacement.
- Made the built-in `surface-probe` discoverable through normal task-type search and added structured CAPTCHA/press-and-hold detection with a bounded manual handoff. Truncated, omitted, or unreadable frame observations now block scale instead of silently passing. Task Master never solves, bypasses, or delegates the challenge to a third-party solver.
- Exposed read-only Task Pack lifecycle, usage, discoverability, and deletion-blocker summaries through MCP, while keeping note/deprecate/restore/delete authority in the Owner Console.
- Corrected guarded asset deletion so logically deleted history and failed tasks without a verified resumable checkpoint no longer block cleanup; live, cleanup-unsettled, protected, and genuinely resumable dependencies remain blocked.
- Made Windows MCP registration tolerate transient `EPERM`/`EACCES`/`EBUSY` file-sharing collisions as bounded lock contention without ever granting ownership optimistically; permanent contention still fails closed at the registration deadline.
- Added a durable external-cost ledger for paid Task Packs: the type declares currency and a per-task ceiling, task start requires a smaller explicit budget, trusted code must reserve and settle each paid operation through an idempotent runtime facade, every retry shares the same persisted balance, and completion fails on unresolved reservations or evidence that differs from the ledger. Public task state exposes aggregate usage only.
- Expanded Manager, notification, handoff, Task Pack, MCP, budget, cross-language, desktop/mobile, and real Chromium acceptance coverage.

## 2.6.0 - 2026-08-29

- Added a dedicated Owner Console Task Packs asset view for Pack, standalone, transient, protected system, historical, and orphan executors, with plain-language purpose, owner notes, Agent discovery/lifecycle state, usage, last use, file size, and deletion blockers.
- Added bounded batch note, deprecate, restore, and guarded delete controls. Manager revalidates every selection, serializes deletion against task creation, and protects system assets plus live, cleanup-unsettled, or checkpoint-resumable task dependencies.
- Made CLI one-off task modules transient by default: they retire from Agent discovery after their first safely settled task and become eligible for cleanup only after a seven-day recovery window. Versioned Task Pack upgrades retire older versions and reject downgrades.
- Added centrally owned, bounded recovery for direct GET navigation on transient connection failures and 429/502/503/504 responses, including visible cooldown/backoff state. Potentially mutating actions are never automatically replayed.
- Added bounded Agent final-report rendering to task cards while keeping raw artifacts, diagnostics, logs, and Agent messaging out of the human workbench.
- Expanded static, registry, navigation fault, service, and real Chromium Dashboard acceptance to cover executor discovery, lifecycle, batch management, guarded deletion, responsive UI, and recovery behavior.

## 2.5.4 - 2026-08-29

- Added a fail-fast Agent-host reload gate. Every MCP request carries its runtime version; a missing or stale bridge now stops before task routing with `AGENT_HOST_RELOAD_REQUIRED`, exact version details, and one reload instruction instead of surfacing a misleading task-schema error.
- Preserved Manager's already-redacted field-level error message, safe details, and a correlated request ID through MCP. `TASK_INPUT_SCHEMA_FAILED` now tells the Agent to describe the selected task type and correct the named field once.
- Added one bounded, rotated, permission-restricted Manager operational journal with MCP request-ID correlation, plus `taskmaster doctor --json` for Manager, registration, and recent-redacted-error health without source-code debugging or starting a browser service.
- Added `taskmaster_scale_prepare` and CLI `task prepare-scale` as one-call, registered `surface-probe` preparation for unknown large work; simplified the base Skill so the runtime owns this preflight dispatch while specialized Task Packs retain site logic.
- Repaired an upgrade edge case where a previously verified-empty ephemeral Profile had already been discarded but its interrupted task still retained a stale lease, preventing every later clean Manager shutdown. Recovery is limited to dead Workers, missing Profile records/directories, matching shutdown evidence, and the exact historical interruption states.
- Made owned Hermes registration resilient to harmless YAML quote/comment formatting and runtime-marker-only edits by another Agent while continuing to reject any command, entrypoint, stable identity, or environment change outside that narrow contract.

## 2.5.3 - 2026-08-28

- Isolated Task Master's WorkBuddy MCP child process from host-injected `NODE_OPTIONS`, preventing WorkBuddy's safe-delete shim from changing Profile deletion and cleanup semantics.
- Kept the override scoped to Task Master's own WorkBuddy server entry; system environment variables, other MCP servers, and other Agent hosts remain untouched.
- Added transactional migration for existing and legacy WorkBuddy registrations, preserving host-owned Node executables, metadata, unrelated environment fields, proxy files, and approval files while upgrading old registration fingerprints safely.

## 2.5.2 - 2026-08-27

- Added an explicit, fail-closed cleanup path for task-quarantined ephemeral Profiles: Manager requires the Worker process to be absent and the state-free template directory to be empty before discarding the unusable Profile record.
- Unblocked upgrades from an older Manager stranded by the same safe-to-discard quarantine: the CLI authenticates the old Manager, verifies zero live work, waits for process exit, takes the state lock, revalidates the evidence, and only then starts the new version.
- Kept persistent Profile data and live or non-empty ephemeral Profiles blocked, and preserved the related failed task as cleanup-unsettled instead of rewriting missing browser-close proof as success.
- Updated the Owner Console to explain `需检查`, expose `清理残留` only for eligible ephemeral Profiles, and label normal ephemeral Profiles as task-started rather than showing a misleading manual-window action.

## 2.5.1 - 2026-08-27

- Collapsed static-page survey into one continuous downward wheel stream plus one continuous return stream, with no viewport-sized stop-start staircase; dynamically growing or partially consumed pages retain at most one immediate continuation.
- Made far rendered-target traversal one continuous approach, removed random reverse wheel corrections, shortened wheel-frame and direction-change gaps, and reduced survey reading settlement while keeping minimum-jerk acceleration and precision acquisition.
- Kept the Task Pack dual lane explicit and tested: visible state changes use Human Journey, while read-only DOM text, attributes, current values, and record arrays remain available through fast unpaced extraction; only mutations are rejected.
- Added deterministic long-page gesture-count and pacing-budget tests plus real Chromium proof that a survey has exactly two high-level gestures with one direction reversal.

## 2.5.0 - 2026-08-27

- Rebuilt visible motion around minimum-jerk acceleration: pointer sampling now adapts to travel distance and target size, far controls use a rapid approach followed by precision acquisition, document-edge controls stop futile scrolling, and wheel gestures use 8-32 fine-grained frame-like events instead of visibly separated chunks.
- Added a centrally owned bounded page survey that can move quickly toward the bottom and visibly backtrack. `journey.survey()` exposes the intent to Task Packs without exposing scroll-shape controls, and the interaction audit now proves smooth event density plus required survey backtracking.
- Made text entry unambiguously keyboard-driven. Every character emits its own keyboard path, central pacing supplies the actual inter-character delay with a 12 ms fast-mode floor, and word, punctuation, and burst rhythm remain live-mode controlled; common DOM mutation hidden inside observation `evaluate` callbacks now fails closed.
- Added the built-in read-only `surface-probe` task type and a mandatory probe-before-scale policy when no specialized capability covers a large request. It samples one representative surface, surveys page structure, reports login/challenge/rate-limit signals, recommends one production recipe, and requires a bounded pilot before volume increases.
- Expanded deterministic motion, real Chromium survey/backtrack, keyboard-event timing, evaluate-bypass, built-in probe, completion-audit, connect, and full local/cross-platform release-gate coverage.

## 2.4.0 - 2026-08-27

- Made `fast`, `auto`, and `human` mechanically identical across the base action facade as well as Task Packs: every mode keeps rendered traversal, curved pointer paths and corrections, in-target clicks, per-character input, keyboard selection, segmented scrolling, and reading dwell. Task Pack journeys continue to add mandatory visible-transition verification.
- Restricted behavior differences to central timing and guard depth. Pointer and wheel topology no longer shrink in `fast`, and task-supplied click or typing delays cannot override the live Profile policy.
- Extended live switching through in-flight pacing boundaries, including recalculating an interrupted reading dwell under the newly Worker-applied mode without replacing the task, attempt, browser, Worker, or lease.
- Added explicit `profile` versus Worker-confirmed behavior state. Task cards now show the actual configured/effective runtime mode and Manager receipt time, and show a pending state until a Worker receipt exists.
- Expanded action-isomorphism, live Worker receipt, negative acknowledgement, real-browser acceptance, and Owner Console UI coverage for both Profile kinds and all three behavior modes.

## 2.3.0 - 2026-08-27

- Exposed `fast`, `auto`, and `human` on both persistent and ephemeral Profiles. New persistent Profiles default to `human`; new ephemeral Profiles default to `auto`; legacy `adaptive` settings migrate in place without moving browser data.
- Added Worker-confirmed live behavior control. Changing a Profile during an active task releases the current pacing wait and applies at the next scheduling, pointer, key, or scroll boundary without replacing the task, attempt, browser, Worker, or Profile lease.
- Made live changes fail closed: Manager requests are serialized per Profile, rapid changes preserve the latest selection, stalled IPC is bounded, and a missing or invalid Worker acknowledgement stops the task instead of silently retaining an old mode.
- Separated journey mechanics from pacing. Every versioned Task Pack keeps rendered traversal, curved pointer movement, in-target clicks, keyboard cadence, segmented scrolling, reading dwell, and transition verification in all three modes; the Profile controls only their speed and caution.
- Renamed the public adaptive policy to `auto`, retained bounded migration compatibility for persisted history, and surfaced configured, effective, and automatic guard state consistently through Dashboard, CLI, MCP, task status, and documentation.
- Expanded real-browser, API, migration, concurrent-switch, negative-acknowledgement, Owner Console, and full release-gate coverage for the new live Profile behavior contract.

## 2.2.0 - 2026-08-26

- Added the central `full-human-v1` Human Journey engine: rendered-page traversal, segmented wheel gestures, curved pointer paths with correction, in-target clicks, keyboard input and native selection cadence, bounded reading dwell, and verified visible navigation.
- Made `full-human-v1` mandatory for every versioned Task Pack. Pack modules now define workflow intent, selectors, pacing limits, extraction, checkpoints, outputs, and evidence while the runtime owns physical browser behavior.
- Added read-only Page, Context, Frame, FrameLocator, and Locator observation facades plus Pack source preflight so direct Playwright mutation and legacy action bypasses fail closed.
- Added a ten-check `interaction-audit.json` completion gate. A contracted task cannot publish success unless visible target acquisition, pointer/click mechanics, input cadence where applicable, segmented scrolling, transition verification, bypass absence, and step settlement all pass.
- Migrated all five Task Pack recipes and the real Chromium acceptance task to Human Journey, added an offscreen pagination browser test, and expanded acceptance to validate the generated 10/10 audit and cleanup.
- Stabilized native select interaction across Windows, macOS, and Linux with focus-preserving keyboard traversal, explicit value verification, and one audited Playwright fallback when a host-owned picker does not commit; also bound OpenClaw process-tree cleanup to the actual runner OS during cross-platform shim validation.
- Kept the boundary explicit: Human Journey improves reliability and consistency but does not spoof fingerprints, bypass CAPTCHA, or promise that websites cannot identify automation.

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
