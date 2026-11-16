# Small replies, complete capabilities

Operations use one CLI JSON contract for all Agents. The default reply is a small decision view, normally bounded to 4,000 JSON characters, not a repeated audit dump. This is a presentation boundary, not a permission change or a new execution mode.

## Routine decisions

The current command ID/status, page identity/version, protected-context warnings, decision requirements, and unresolved effects remain available. Scene items retain fresh references, semantic roles/names, safe current values and meaningful state. Executable references resolve through the same private, document-bound target registry; a long CSS path need not be returned on every step. Peer-page reads retain their selectors-with-pageId contract.

Healthy confirmed current-command replies omit route-known operation/task IDs, successful ID-only action details, routine timing arrays, empty/null control defaults and explicit no-check verification. They retain the current command ID/status and page identity/version. These omissions never imply a verified business result: absent verification means no positive readback claim. An omitted exact default `identityStatus` means the website account is **not verified**; verified identities and any identity warning remain explicit. Start/get/stop still identify the selected Profile and current authorization. Complete stored receipts retain all original fields through the existing full read.

In complete compact scenes, missing `offset` and omission counters mean zero; missing continuation means none, and a missing total is derived from represented items plus explicitly redundant items. Partial/delta scenes keep their necessary counts and omitted ranges. Identical complete text/value content is shown once through `value`; partial field ranges are never conflated. Generic paragraph/container tags can be omitted when a fresh reference and content already identify the node.

Default scene text reports represented content once rather than repeating a container's entire descendant text above every child. Full browser captures can still return the legacy aggregate representation. `omitted`, continuation options, and full-evidence pointers distinguish absent content from content that has not been returned. False/default-only item fields can be omitted; explicit unchecked checkboxes and collapsed/unselected states remain meaningful data.

Use the scene already returned after an action. Group deterministic authorized preparation in the existing batch, with preconditions and verification. A newly revealed menu, notice, account identity, or confirmation phrase is still a real decision boundary. Do not guess its contents to reduce calls.

For successive same-scope reads in a client that retains its current scene, explicitly supply the preceding `baselineId` in the next observe payload or batch `payload.observation`. Apply changed items and `removed` refs only when `delta:true`; on `baselineReset:true`, page/document change or a missing baseline, replace the cached scene with the returned bounded full scene. Omitted items are never evidence of removal. Partial capture contexts reset the baseline instead of asserting removals. This existing explicit option is not silently injected by the CLI and is part of the requested command; replay IDs with their original envelope. A deliberately requested delta receipt remains a delta receipt on historical full retrieval, not an unrecorded full past page.

At connection or Agent handoff, retain the operation/task route, selected Profile, latest command/action IDs, event cursor and unresolved work separately from the compact reply. A new client that did not receive the retained scene must issue a fresh observation without the prior `baselineId`, even if that ID is still known by the Worker. This refresh stays in the same operation/Profile; it does not replay actions or require loading the entire historical audit.

## Complete reads without execution

```text
taskmaster ops get OP_ID --command COMMAND_ID --detail full --json
taskmaster ops get OP_ID --detail full --json
taskmaster ops events OP_ID --after CURSOR --detail full --json
```

`--detail full` controls presentation and is not part of the command fingerprint. It restores the exact stored internal receipt, including its captured selectors. It does not send the action again or reconstruct a past page that was never captured.

A fresh expanded browser capture is a normal read command:

```json
{"kind":"observe","payload":{"detail":"full","ref":"COPY_FRESH_REF","maxChars":12000}}
```

Use either a returned reference or a unique scope. Returned text continuation options include the exact source mode and page/version binding. Replay them unchanged. A continuation of `textMode:"own"` remains own text even if it requests a full-shaped response; a fresh full capture without that mode separately reads aggregate ancestor text. A navigation, replaced target or changed chunk source is rejected rather than silently concatenated.

The internal capture allowance and public output budget are separate. Private reference paths must not consume the small Agent budget and hide controls that would otherwise fit. Explicit caller capture limits remain honored. Large text is returned through bounded, explicit continuation rather than silently discarded.

Long accessible names and current values have the same complete-read contract: `nameRange`/`nameContinuation` and `valueRange`/`valueContinuation`. Default name/value slices are 512 characters, with explicit per-field limits up to 8,000; replay the supplied options for the next slice. A partial name is not an exact role/name locator: use its fresh `ref`. The complete source is redacted before slicing, and a protected redacted span is returned atomically so chunk boundaries cannot reveal a secret or change its offsets. A tiny requested slice can therefore include a whole protected span or small boundary context, while the overall response budget still applies. Arbitrary custom offsets that would create a new redaction boundary fail with `UNSAFE_TEXT_OFFSET` without shifting the requested start; use the generated continuation instead. The wire formatter does not invent new offsets from an already-partial source whose remaining text it cannot inspect.

## Historical and safety evidence

Default get/start/stop responses report the operation, selected Profile, authorization summary, pending/current work, unresolved effects, counts and relevant receipt pointers. They do not repeat old observations, task event histories or business records. Complete audit reads remain explicit.

Large terminal receipts are immutable content-addressed evidence behind the active ledger; see [persistence](OPERATIONS-PERSISTENCE.md). Unknown effects and their replay-protection evidence remain active. Full reads verify their cold evidence, and unavailable or corrupt evidence is an error, not an empty result.

If formatting cannot fit safety information after execution, the response retains the real command ID/status, says `needsDecision:true`, and provides `fullReceiptRequired` plus an exact retrieval command. `OUTPUT_CONTEXT_INSUFFICIENT` is not an ordinary unexecuted request rejection and never authorizes automatic replay. Full stored truth is not rewritten to manufacture a formatting failure.

`COMMAND_RECEIPT_UNAVAILABLE` is different: execution may already be durably complete, but the stored receipt could not be read. The outcome receipt retains the original command identity/status and original storage failure code, sets `receiptUnavailable:true`, `evidenceAvailable:false` and `requiresOwnerRecovery:true`, and prohibits automation/replay. It deliberately has no full-receipt link implying that unavailable evidence is currently readable. Restore and verify the matching snapshot, journal and evidence as one state unit before further automation; never submit the same effect under a replacement ID. An explicit read-only full GET still fails with its original storage error and an `operationReceipt` in the error details, rather than returning an incomplete receipt as full evidence.

## Accurate conditions and target identity

Every declared condition is validated before the action group starts. Unknown keys, unknown states, malformed predicates and contradictory absence/content checks fail closed. Supplied URL, state and content predicates are combined with AND; a matching URL cannot stand in for an unchecked result text. `checked` reads actual checkbox/radio or ARIA state. `values` verifies the complete selected-value multiset; scalar `value` cannot claim a multi-select collection is correct.

Declared `expected` checks run for read/locate/wait actions as well as writes. Per-action `expectedMatched`, the actual `actionExpectedMatched` count and an explicit `groupMatched` distinguish what was checked. A group-level business-readback flag requires a checked final group or checked expectations for every external effect in that group. These flags establish only that the declared evidence matched; the Agent must still choose evidence that proves the intended business outcome.

References bind the originally observed connected node rather than its ordinal CSS position. Moving that same node does not change its identity; replacement or detachment stops with `STALE_OBSERVATION`. Native actionability, typing, dragging and hit testing remain in place. Same-document references can support exact post-fill readback, while navigation, tab selection and manual control invalidate the relevant stale bindings. Cancellation, control ownership and dialog state are checked again at the native dispatch boundary.

The page/document/control binding captured before authorization and persistence waits also constrains that dispatch boundary, including semantic, selector, coordinate and focused-key actions. A replacement document cannot become the new accepted baseline merely because it appeared during an acknowledgement wait. The current observation's references remain retained when the bounded caches evict older entries.

An action group has one monotonic deadline. Explicit waits, predicate checks and dispatch share the remaining group budget; a positive predicate that arrives after the deadline is not a successful timely check. The deadline is checked again after asynchronous preparation before starting a native action. It cannot undo an already in-flight external effect, cancel necessary persistence of completed facts, or establish that a timed-out submission was not applied; uncertain effects still require readback and reconciliation before any replay.

## Diagnostics and measurement

Failed commands retain bounded stage timing evidence, with an artifact reference when available. The ring records stage/action identifiers, codes and elapsed time—not page text, input values, selectors, URLs or error messages. Ordinary successful replies do not carry the timing arrays. Optional diagnostic capture does not retry or relax an action.

Compare actual serialized reply characters/bytes separately from runtime and successful business outcomes. They are not actual model-token or inference-cost measurements. A smaller response is only acceptable when target discovery, values/states, complete text expansion, cross-tab reads, safety decisions and exact historical retrieval still work.
