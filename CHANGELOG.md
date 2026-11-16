# Changelog

## 4.2.1 - 2026-11-16

- Further separate healthy model-facing success replies from complete stored receipts, omitting repeated route IDs, ID-only successful action detail, routine timings and empty defaults. Preserve explicit warnings, unknown effects, command/page identity and positive readback evidence. Document explicit baseline reuse without silently changing command envelopes.
- Validate every declared condition before any action; AND together URL, DOM and value predicates instead of accepting the first match. Verify actual checked states and complete multi-select collections, and reject unsupported conditions rather than treating them as visibility checks.
- Execute and record declared expectations for read/locate/wait as well as writes; distinguish action checks, checked final groups and unchecked effects.
- Bind reference actions to the originally observed node through native selector resolution, retain same-document post-fill readback, reject replacement/detachment and recheck cancellation/control state at dispatch. Preserve native typing/dragging and cleanup interrupted new-tab creation.
- Correct wrapped-label accessible names and conservatively reset partial observation baselines instead of reporting unobserved refs as removed.
- Carry the pre-acknowledgement page/document/control binding through the final native dispatch boundary. Reject navigation during authorization or persistence rather than retargeting a same-named control on the replacement page.
- Apply one monotonic action-group deadline to waits, checks and dispatch, including time spent awaiting authorization and persistence. Preserve uncertain-effect reconciliation and already committed completion evidence.
- Refresh reference-cache recency on observation and retain the current scene's references when enforcing the existing bounded cache.
- Include the output, persistence and stream contracts in every native/portable runtime, with missing-document rejection during bundle verification.
- Refresh the bilingual project homepage and reusable banner, and make Latest the default new-deployment entry. Runtime, Skill and running Manager versions must still be checked separately; this changelog alone is not installation or publication evidence.

## 4.2.0 - 2026-11-16

- Default operations output to a bounded decision view, with semantic references, safe current values/states, explicit omissions and directly replayable continuation. Preserve exact stored receipts, selectors and full audits through explicit full detail; fresh expanded captures remain separate reads.
- Remove repeated ancestor text before the capture budget and keep private selector paths out of routine wire output. Keep meaningful warnings, operation/Profile identity, unknown-effect bindings and post-execution formatting fallback receipts.
- Separate large terminal replies into durable immutable content-addressed evidence. Preserve active safety state, logical storage limits, hash-checked recovery, strict v1/v2 migration and fail-closed missing evidence. Reuse transaction-local immutable canonical serialization instead of repeatedly generating the same JSON.
- Finish narrow current-command/ready/scheduler/event projections and single-reply hydration; retain live authorization, one durable dispatch fence, per-line Manager ownership checks and uncertain-effect replay protection.
- Retain bounded command-stage timing evidence on failures without capturing page/input content or adding action retries. Distinguish native action, verification, authority, observation and result-persistence boundaries.
- This source version requires separate release and installation verification; local tests do not establish publication or upgrade an existing Manager.

## 4.1.0 - 2026-11-15

- Make ordinary operations as direct as batch scripts: use the selected/saved default Task Master Profile without website identity-selector or permission-table setup. Keep legacy explicit identity/resource envelopes as optional guards; remove host-specific local-browser routing from the product and shipped guide.
- Reuse one operation/Profile across tabs, return titles and URLs, select a unique tab by title/URL/page ID, support cross-tab action groups and concurrent independent tab reads. Keep unfinished operations and browser scenes alive.
- Return actual command replies and the next compact observation in one CLI call, generate omitted command/action IDs and use document/element identity rather than unrelated DOM noise for action freshness. Metadata checks no longer scan/layout the entire page.
- Include contenteditable controls in observation and support their text/value readback. Publish one shared action catalog including targeted/global keys, sequential typing, hover/drag, tab/history control, authorized uploads, completed download artifacts and viewport screenshots.
- Preserve original failure phase/cause/target. Non-effect navigation failures no longer create unknown-write locks; strict identity failures remain diagnosable, same-URL readback does not repeatedly reload, and uncertain actual effects still require reconciliation before new effects.
- Add a quiet local `ops listen` path: no model requests or empty model-facing heartbeat output while waiting. Keep host wake-up support distinct from a listener process, and retain the generic executable/stdin event contract.
- Decouple non-Codex Agent calls from an unrelated Codex Skill installation and document one UTF-8 JSON/CLI contract across hosts. Keep stop, takeover, revocation, explicit limits, redaction and external-effect replay protection.
- Support JSON stdin, UTF-8 BOM input and small schema sections for host output limits; document Hermes's native terminal/completion-notification path without a provider-specific browser integration.
- Allow explained task-specific readback of general browser actions, including actual audit/result pages and definite non-application, while binding the outcome/evidence to the Agent decision and retaining strict legacy guards when explicitly configured.

## 4.0.2 - 2026-11-15

- Treat an Owner-authorized upgrade as replacement and activation: the new Manager synchronizes the selected installed driving Skill with its bundled version before reporting ready, retaining the previous Skill outside active discovery.
- The Manager rejects old clients before new work; each recognized Agent must reload and acknowledge the current Skill independently. Matching-Manager Skill updates occur in the background without stopping active work.
- If an old Manager is busy, offer the Owner a choice to wait or explicitly stop its work for replacement. Silent upgrades never select force automatically, and safe task stop/read controls remain available.
- On Windows, recognize the previous managed `v3` sibling installation, retain its files in a recovery backup and replace its old launcher path with a forwarder to the current application. Unknown directories and unsafe replacements fail closed.
- The Windows replacement installer attempts Manager and Skill activation automatically and returns exit code 20 if activation is incomplete, leaving the installed files in place for an explicit retry.
- Do not rewrite an unchanged healthy Profile registry during a routine lease-recovery check; retain the existing state-drift guard and recovery behavior.
- Clarify that installing a package alone is not completed activation; describe the default Codex Skill location, explicitly selected alternative location, portable replacement and limits for older downloads and other Agent hosts.

## 4.0.1 - 2026-11-15

- Correct the Media Bridge / 媒介桥 link in the bilingual READMEs, Dashboard and current release documentation to `https://npcpressbridge.com/`; retain the approved product name and all runtime behavior.
- Publish matching 4.0.1 runtime packages and driving Skill so new Agent and user deployments have a consistent versioned entry. Existing installations are not silently upgraded.

## 4.0.0 - 2026-11-15

Major release: combine the persistent operations introduced in 3.2.0 with an optional real online Agent handoff and complete same-version runtime/Skill distribution. Ordinary `.mjs` jobs remain supported; the runtime does not become a general-purpose autonomous Agent. See the [4.0.0 release notes](docs/releases/4.0.0.md) for deployment and evidence boundaries.

- Add the optional online Codex CLI host adapter with explicit configuration, persistent event claims and model-call slots, bounded child-process lifetime, verified handled receipts, and only allowlisted read-only observation or safe stop decisions. It does not wake the original desktop chat or authorize business writes.
- Record completed isolated Windows online-adapter acceptance: 14,401,755.9 ms, 238 samples, maximum 61.01-second sample gap, two new actual CLI Agent decisions, zero idle adapter calls, interrupted-delivery recovery, refusal of unauthorized publication, no simulator business writes and successful cleanup. Reuse only the earlier scheduled-entry assertion with unchanged adapter/core hashes, not elapsed time. Source-tree evidence remains separate from native package and public-asset verification.
- Include the adapter, its guide and the version-matched driving Skill in every native/portable runtime, while retaining the standalone Skill ZIP. Verify packaged adapter imports and Skill/runtime version agreement.
- Rewrite the bilingual product overview and 4.0.0 deployment path around batch/operations, explicit browser selection, human takeover, authorization, readback and recovery. Preserve NPC branding, the CLI-first core and separate runtime/Skill upgrades.

## 3.2.0 - 2026-11-15

- Add persistent operations sessions through the CLI and the existing Manager/Worker lifecycle, with bounded action groups, scoped and differential observations, local condition waits and explicit decision events. Keep ordinary script tasks compatible and add no model or production dependency.
- Add durable authorization, pre-effect action acknowledgements, business records, uncertain-result reconciliation, schedules and a bounded event outbox with an explicitly configured host delivery adapter. A delivery receipt is not an Agent decision or proof of native closed-session wake-up.
- Add opt-in single-send transport for explicitly selected owned Profiles and known small same-origin JSON POST effects, with exact request guards, a durable one-send allowance, late/repeated-request blocking and readback after uncertainty. Native unguarded browser/site retries and unsupported platform transports remain outside this policy; this is not universal exactly-once delivery.
- Recover uncertain read-only navigation by verifying its exact original destination and currently authorized identity while retaining the original source resource record; external writes retain same-resource reconciliation.
- Support exactly two execution modes, batch and operations. Profile settings choose a fixed default or auto policy; an explicit task mode overrides only that task. Human takeover is a separate pause lock, never a third execution mode.
- Add an optional NPC-orange operation cursor with click-through, observation/screenshot isolation and an existing Tasks visibility control, plus fresh-scene durable acknowledgement of safely cancelled native dialogs without replay or fake action reconciliation.
- Add isolated social, advertising and website workflow fixtures, concentrated browser acceptance and real-time soak tooling. Real account operations, native host integration and public release remain separate validation and authorization scopes.
## 3.1.11 - 2026-10-26

- Add a quiet NPC and Media Bridge introduction beneath the Dashboard workspace, with explicit external links, larger readable text and a native, expanded-by-default overview of open-ended browser workflows.
- Keep the approved Chinese copy and its English translation aligned with the bilingual README introductions. Preserve Tasks and Profiles as the only views, with no tracking, automatic external requests, new services or task-control changes.
- Verify keyboard disclosure, language switching, responsive layouts, link safety and unchanged task/Profile/cleanup controls through the existing isolated Dashboard acceptance.

## 3.1.10 - 2026-10-25

- Batch cleanup metadata snapshots instead of rewriting the full task history after every output directory; persist completed batches and the final partial batch, and avoid no-op updates while still checking for late-arriving files.
- Delete at most four ordinary sibling files concurrently while preserving managed-root, ancestor, link, identity and Profile-login safeguards; recurse into directories only after the current leaf batch finishes.
- Keep cleanup progress and the latest outcome in the existing status response. Let the Dashboard follow a long-running cleanup across dialog reopening or request interruption without duplicate deletion requests or a misleading one-minute timeout.
- Add large-history write-count, repeat-cleanup, partial-failure, bounded-concurrency and isolated Dashboard regressions. No new service, database, scheduling engine or runtime dependency.

## 3.1.9 - 2026-10-20

- Expose the existing failure screenshot as a nullable, artifact-relative reference in task snapshots returned by status/follow. Allow only the Worker's fixed `failure.png` artifact name and hide the reference after output cleanup; preserve old task compatibility without new storage, I/O, commands or services.
- Keep task handoff and result summaries in the existing Skill by composing status/follow/files. Distinguish partial business results from terminal process state, refresh stale handoff state, and preserve secret-free cursor and artifact references.
- Clarify script-owned atomic checkpoints, explicit new attempts after Manager restart, uncertain external-effect handling, and host-owned Agent wakeup. Do not automatically replay failed scripts or persist secret task input for recovery.
- Verify the diagnostic reference through isolated service regressions and a real Chrome failure followed by the existing CLI artifact reader.
- Launch Windows cross-host test fixtures through a no-console GUI bridge and assert that packaged and breakaway fixture hosts have no console window; keep the production runtime unchanged.

## 3.1.8 - 2026-10-10

- Keep one selected same-user Manager and Profile pool across Agent hosts. Resolve Windows packaged/unpackaged state views to their physical store while preserving the selected legacy identity and Profiles across restarts, without silently merging or creating a replacement pool.
- Isolate explicitly selected data projects, discover their own ports and publish locations atomically. Verify physical identity and a nonce ownership proof before transmitting credentials; copied state cannot take over another project.
- Reuse compatible running Managers during ordinary startup. Make runtime replacement an explicit idle-only `--upgrade` action; refuse downgrades and occupied native install/uninstall without stopping other Agents.
- Preserve Profile names, IDs, defaults and browser files when a verified state alias is rebased. Reject data within replaceable application payloads, and complete shutdown after task cleanup even when an HTTP client is unfinished.
- Keep background cleanup from racing an in-progress graceful task stop or changing a successful stop into a termination error; other Profiles continue running independently.
- Consolidate a selected legacy Windows union view only during explicit Owner upgrade, verify its complete copied tree, retain the original, and keep shared/project locations separate. Refuse incomplete Profile rebasing instead of opening an empty replacement Profile.
- Retain the one-script/one-command workflow with no new dependency, per-Agent service or normal-task preflight. Add real Windows packaged/unpackaged and concurrency regressions alongside native installer safety acceptance.

## 3.1.7 - 2026-10-10

- Prefer a running Windows Manager's verified embedded runtime over older PATH or installation entries, including when uninstall registration is unavailable. Keep an unlocatable live Manager unresolved instead of silently selecting an older launcher.
- Include the CLI's resolved state directory, port, and expected/actual identity fingerprints in state-mismatch errors without exposing credentials or changing recovery safeguards.
- Add regressions for missing/stale registration, old launcher coexistence, unreadable process ownership, package-version mismatch, and secret-free state diagnostics. Preserve the existing Windows path-canonicalization algorithm and user state.
- Drive the transient-write recovery regression with controlled interval ticks instead of flooding slow CI storage with 10 ms wall-clock polls; retain its real three-second completion deadline and all production recovery behavior.

## 3.1.6 - 2026-10-09

- Include a read-only Windows launcher locator in the Agent Skill. Prefer the registered `InstallLocation` over an old Agent-host PATH and recognize custom installations and known nested portable extractions.
- Distinguish a found launcher, unresolved installation evidence, and confirmed absence. Uncertain registry/path/loopback queries or an existing Manager never authorize automatic reinstall, configuration changes, or Profile recreation.
- Verify stale/missing PATH discovery, both uninstall records, retained data, no launcher execution, portable fallback, and conservative loopback health handling with isolated Windows regressions.

## 3.1.5 - 2026-10-09

- Recover retained v3 Profile directories into the Manager and Dashboard when their registry metadata is missing or incomplete. Preserve browser files and existing names/defaults; leave Profiles with active or uncertain Chrome ownership quarantined.
- Reclaim a stale Windows Manager lock when its recorded PID has been reused by a later process; record process creation identity for new locks and keep uncertain ownership fail-closed.
- Tell a new Agent to check for an existing Manager and import only the Skill when one is present, including portable launchers not on `PATH`. Clarify state-mismatch recovery without reinstalling or recreating Profiles.
- Clarify that Playwright is bundled with the Manager and does not require per-Agent version selection; leave the internal dependency pin in package metadata.

## 3.1.4 - 2026-09-08

- Return the fixed Dashboard link without opening a browser for `panel --json`; explicit `taskmaster panel` still opens it. Align the Agent Skill and bilingual quick start so repeated tasks do not accumulate Dashboard windows.
- Replace the Dashboard header and favicon with the current NPC Signal Flow brand assets; preserve task, Profile, and manually opened browser lifecycles.
- Add an explicit NPC website link to Dashboard navigation, the Logo, and both README introductions; external links open only on user interaction.
- Ignore stale containment callbacks after task finalization, so late lease-renewal failures cannot revive completed tasks or block output cleanup.

## 3.1.3 - 2026-09-08

- Reload local token changes without restarting Manager; refresh a long-running CLI request once when its former token is rejected before dispatch.
- Detect a different state directory or replaced task/Profile state and return an actionable state error. Lightweight file-identity checks reject detected external changes and fence both stores; restoring data still requires stopping Manager first.
- Replace an idle stale Manager automatically. Explicit `taskmaster manager recover` contains its active processes before reloading state, using a scoped proof instead of sending the primary token to a mismatched service.
- Put the managed Windows CLI first in the user `PATH` while preserving unrelated entries, so old temporary launchers cannot shadow an installed update.
- Add isolated and real-process regressions for token drift, legacy configuration, recovery races, active/waiting tasks, manual Profiles, state-write conflicts, and Windows launcher precedence.

## 3.1.2 - 2026-09-06

- Keep the Dashboard task list limited to current work: queued, running, waiting, automatically paused, and stopping tasks. Finished, stopped, and failed tasks leave the list on refresh, including when opened through an old task link.
- Count only visible tasks, label queued work accurately, and show a concise empty state. Preserve task records and output for CLI follow and explicit cleanup; hiding a card never deletes files.
- Exercise automatic task removal, terminal states, empty lists, old links, and stop/resume behavior in the real Dashboard acceptance.
- Drive resume-timeout regressions with a controlled clock so CI filesystem latency cannot create false acknowledgement failures; production timeouts remain unchanged.
- Query Windows Chrome command lines directly through WMI without loading CIM cmdlets on the first Profile probe. Keep one query, the five-second limit, exact Profile matching, and unknown results on enumeration failure.

## 3.1.1 - 2026-09-06

- Keep observing the single Chrome close operation after its ten-second deadline, so a later confirmed close can acknowledge cleanup and release the Profile without unnecessary force termination.
- Retain the original timeout failure and task output; report whether closure timed out or threw, with elapsed time and bounded, redacted error details. Do not retry closure or extend its deadline.
- Add regressions for late-close acknowledgement, missing Manager acknowledgement, close errors, and Profile release through the Worker/Manager cleanup protocol.

## 3.1.0 - 2026-09-05

- Send a desktop notification immediately when verification stops work, then every 30 seconds until actual resume, explicit stop/delete, completion, or automatic pause at 20 minutes. Notification failures never gate task control.
- Preserve Chrome, Worker, Profile and checkpoint on automatic pause; require manual resume after the deadline and retain the final screenshot for diagnosis only.
- Bound startup cancellation and resume acknowledgement, reject obsolete probes, and handle tasks that complete immediately after resuming without false failures.
- Contain background Profile cleanup failures with bounded retries, recover after transient state-write failures, bound stalled IPC sends, and reuse confirmed cleanup within one lease.
- Terminate detached descendant process groups during POSIX forced cleanup using bounded ownership snapshots; retain the lease when browser inactivity cannot be confirmed.
- Coalesce frequent progress writes, avoid global task-history rewrites for heartbeats, and share recent output-budget scans on progress.
- Add optional submission request keys and bounded follow calls; drain retained terminal events before returning the final cursor.
- Reuse API-compatible Managers without automatic replacement on normal commands; guard explicit idle maintenance against concurrent task/Profile creation.
- Add clock-driven notification, real Windows notification submission, real Chrome verification, lifecycle, and control-race regressions.
- Run one CI/CodeQL gate per pull-request update and a separate exact-main push gate for publication, avoiding duplicate feature-push checks without removing any required platform or release verification.

## 3.0.3 - 2026-09-04

- Added a three-category Dashboard space cleaner: preview before deletion, preserve login/extension data, skip active Profiles/tasks, and require opt-in for historical task output.
- Opened manual Profile windows with native stable Chrome, without a Playwright or CDP connection; automated tasks reuse the same Profile after the manual window closes.
- Added verification waits with live browser/Worker heartbeats, four five-minute screenshot probes, and Agent-reviewed or manual resume.
- Paused execution timeout accounting during verification waits and rejected stale screenshot resume references.
- Returned screenshot attention and a continuation cursor from CLI follow without ending the task.

## 3.0.2 - 2026-09-04

- Enabled Chrome sandboxing for manual Profile windows and automated tasks while retaining extension support and raw Playwright/CDP access.
- Added launch-configuration and real-browser regression checks to prevent silent unsandboxed startup.
- Added installer-free portable ZIPs for every supported OS/CPU, with bundled-runtime startup and cleanup acceptance on each native CI target.

## 3.0.1 - 2026-09-04

- Fixed early Manager and Profile Worker exits being reported as unhandled promise rejections.
- Aligned manual Chrome startup timeouts, maintained startup heartbeats, and preserved bounded underlying failure details.
- Added Profile renaming to the bilingual Dashboard.
- Resolved release tags explicitly and added read-only verification of immutable published assets.

## 3.0.0 - 2026-09-03

Eric Task Master 3.0 is a clean CLI-first runtime.

- Replaced registered Task Types and Task Pack assets with direct disposable `.mjs` execution.
- Removed MCP, host registration, exact adapter version coupling, mandatory surface probes, Journey/Human behavior, special verification handoff, and completion gating.
- Unified Profiles as persistent stable-Chrome directories with one configurable default.
- Added heartbeat-based stale lease recovery and atomic stop/delete.
- Added streaming progress, partial outputs, generic wait/resume, and direct Playwright/CDP access.
- Rebuilt the Dashboard around Tasks and Profiles only.
- Added self-contained Manager bundles for Windows, macOS, and Linux.

For 2.x history, see Git tags through `v2.9.2`.
