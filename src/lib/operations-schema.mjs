import { ACTION_TYPES, MAX_BATCH_ACTIONS, actionHasEffect } from './operations-actions.mjs';

export function operationsSchema({ now = Date.now(), section } = {}) {
  const expected = { target: { selector: '#current-value' }, text: 'approved-new-value' };
  const schema = {
    schemaVersion: 1,
    executionModes: ['batch', 'operations'], selectionPolicy: 'auto',
    browserModel: 'Every task uses one Task Master-owned Profile, selected by --profile/profile or the saved default. One operation reuses all its tabs. Host-specific routing outside Task Master is not a product rule.',
    defaults: { authorization: 'profile-scoped until stopped/revoked; optional explicit expiry/limits', commandWaitMs: 30000, generatedCommandAndActionIds: true, automaticObservationAfterBatch: true, replyDetail: 'compact', closePolicy: 'Keep the operation/browser alive until explicitly stopped; errors return a scene rather than closing it.' },
    output: {
      default: 'Compact decision view, normally bounded to 4000 JSON characters. It omits repeated ancestors, private selector paths and complete text-range boilerplate, not execution capabilities.',
      targets: 'Use fresh item.ref or exact role/name. Selectors remain available in explicit full captures and full stored receipts. Peer-page observations keep selectors-with-pageId.',
      state: 'Names, safe current values, disabled/checked/expanded/selected and other meaningful states remain available. Missing false/default-only fields are not missing controls.',
      fullReceipt: 'taskmaster ops get OP_ID --command COMMAND_ID --detail full --json returns the exact stored receipt without execution. --detail full controls presentation only, not the command fingerprint.',
      fullCapture: { kind: 'observe', payload: { detail: 'full', ref: 'COPY_FRESH_REF', maxChars: 12000 } },
      continuation: 'Replay returned continuation/textContinuation/nameContinuation/valueContinuation options exactly, including ref or scope, offsets, textMode and page/version bindings. own/full text bases must not be mixed. Partial names are not exact role/name locators; use their refs. Omitted content is not evidence of absence.',
      history: 'Default get/stop/start return small operation receipts and counts, not entire historical scenes. Use their fullEvidence pointer or explicit --detail full for audit.',
      safety: 'Unknown effect identities, pause/takeover/revocation and warnings remain visible. OUTPUT_CONTEXT_INSUFFICIENT after execution retains the real receipt ID/status and requires fullReceipt retrieval before further decisions; it is not permission to replay.',
      batching: 'Reuse the scene returned by the preceding command. Group deterministic authorized steps with explicit preconditions; keep real decision boundaries for newly revealed content. Do not add an unused observe between every action.',
      routineDefaults: 'Healthy current-command replies can omit known route IDs, successful ID-only action rows, timings and empty control defaults. Missing verification is NOT business verified; missing default identityStatus is NOT website-account-verified. Full stored reads retain the original evidence.',
      delta: 'Explicitly reuse baselineId only when retaining that same-scope scene. Apply delta items/removed refs; baselineReset or page/document change replaces the baseline. Partial captures never prove removal. No CLI silently changes the command envelope to request delta.'
    },
    precedence: 'Explicit task mode overrides the Profile default for this task only; auto uses Skill recommendation, declared intent, then finite batch compatibility default.',
    safety: [
      'Use the selected/default owned Profile within the user task. Selecting a Profile is not proof of a particular website login; the Agent verifies the visible account/resource when relevant.',
      'General operations do not require account/resource selectors, action allowlists or hand-copied page versions. Explicit legacy accountId authorization remains strict identity mode and is never silently broadened.',
      'Observe the task scene before acting. Selectors, exact role/name, exact text, fresh refs and viewport click/hover coordinates are supported. Optional preconditions/expected/verify add task-specific checks. Ordinary DOM mutations do not invalidate an unchanged document/target.',
      'A confirmed primitive without positive verify means the browser action completed, not that a publication/payment/configuration was delivered. Verify the business result before reporting completion. An uncertain external effect blocks new effects, not diagnostic inspection or declared non-effect actions. Never change IDs to replay it.',
      'singleSendTransport is an immutable explicit operation opt-in (default false) for owned Profiles, same-origin small non-sensitive JSON POST only. Every effect action requires an exact transport guard. SW, iframe/new-tab writes, uploads, HTTP authorization and redirects are unsupported. Failures stay unknown; no fallback/replay. A URL/method/body digest can be consumed only once per context. This is not universal exactly-once delivery.',
      'control acknowledge-dialog requires a fresh pageId/pageVersion and main-Agent reason. It only acknowledges an already safely dismissed UNEXPECTED_DIALOG; it cannot accept a confirmation, release takeover/pause, clear another unsafe reason, or replace same-resource reconcile for unknown external effects.',
      'No native session-ended/app-closed host wake-up is claimed without a configured and verified adapter.'
    ],
    workflow: [
      'taskmaster ops start --profile NAME_OR_ID --goal "The authorized task" --json; omit --profile to reuse the saved default. Do not create a Profile per task or tab.',
      'taskmaster ops command OP_ID --input @observe.json --json. Commands wait up to 30 seconds and return the reply; --wait-ms 0 retains asynchronous reservation behavior.',
      'Send a bounded batch. Command/action IDs and optional page metadata are filled automatically; keep returned IDs for unknown-result reconciliation. Each successful batch returns a fresh compact observation for the next decision.',
      'Use tabs/select-tab or action.pageId for cross-tab work in the same Profile. Select by unique pageId/title/URL; use observe payload.pageIds for up to four concurrent independent reads.',
      'taskmaster ops listen OP_ID --after CURSOR --json waits locally through empty intervals without model-facing output. A running process alone does not start a model call; a model decision on the delivered event uses that host/model usage.',
      'On unknown effects, obtain uncertain action IDs and their original expected results; reconcile performs only readback navigation/refresh, never resubmission.',
      'ops pause|takeover OP_ID prevents automation. Resume is explicit and requires fresh observation; revoked/expired permission cannot resume.',
      'ops stop-all stops operations only. Original finite script run/follow commands remain supported.'
    ],
    commandKinds: ['observe', 'batch', 'wait', 'screenshot', 'tabs', 'select-tab', 'reconcile', 'control'],
    actionTypes: ACTION_TYPES,
    actionCatalog: Object.fromEntries(ACTION_TYPES.map((type) => [type, { defaultEffect: actionHasEffect({ type }), target: ['navigate', 'back', 'forward', 'reload', 'new-tab', 'close-tab'].includes(type) ? 'none' : ['key', 'type', 'scroll'].includes(type) ? 'optional; omitted uses focused page/viewport' : 'required', ...(type === 'drag' ? { destination: 'to: target object' } : {}), ...(type === 'upload' ? { value: 'absolute path or path array for user-authorized files' } : {}), ...(type === 'download' ? { result: 'Completed file saved in task artifacts; evidenceRef returned' } : {}) }])),
    targets: { selector: { selector: '#unique-control' }, role: { role: 'button', name: 'Exact visible name' }, text: { text: 'Exact visible text' }, ref: { ref: 'COPY_SELECTED_PAGE_REF' }, coordinates: { x: 300, y: 200 }, tabSelection: { titleIncludes: 'Unique business page' } },
    verification: { value: 'Exact scalar input/select/textarea or contenteditable value; a multi-select requires values', values: 'Exact complete selected-value multiset', checked: 'Actual native/ARIA checked state: true, false or mixed', text: 'Exact trimmed inner text', includes: 'Text substring', url: 'Exact URL', attribute: 'attribute plus equals', states: ['visible', 'hidden', 'absent', 'attached', 'actionable'], combination: 'All supplied predicates are ANDed; unknown or malformed conditions reject before any action', businessResult: 'Supply positive expected/verify for the actual result, not just a click or the existence of body. Per-action expectedMatched and final groupMatched reflect checks actually performed; unchecked effects are not business verified.' },
    agentCompatibility: { interface: 'CLI JSON only; no model-specific tools or second model', input: 'UTF-8 JSON via --input @absolute-path or --input - (stdin); inline JSON is optional', output: 'Parse JSON, status/reason and unresolvedActions; do not infer success from exit code alone', hostIdentity: 'Use one stable ERIC_TASK_MASTER_AGENT_ID per known non-Codex Agent session, not per command. Unknown/manual CLI callers can read the bundled guide without any Codex installation.', idle: 'ops listen suppresses empty intervals; actual host process-wait limits still apply. It cannot by itself restart a closed host or wake the original desktop chat.', hermes: 'Use terminal for CLI calls and background=true with notify=true for ops listen (legacy notify_on_complete is host-version-dependent). No heartbeat or model polling is needed. Host notifications must be enabled; the CLI must be reachable from the selected terminal backend.' },
    envelope: { kind: 'observe', payload: {} },
    bounds: { commandBytes: 131072, maxBatchActions: MAX_BATCH_ACTIONS, maxActionGroupTimeoutMs: 60000, eventLongPollMaxMs: 30000, readOnlyParallelScopes: 4 },
    examples: {
      start: { goal: 'Complete the authorized browser task in the selected/default Profile', mode: 'operations' },
      simpleBatch: { kind: 'batch', payload: { actions: [{ type: 'navigate', value: 'https://example.com' }] } },
      richText: { kind: 'batch', payload: { actions: [{ type: 'fill', effect: false, target: { selector: '[contenteditable="true"]' }, value: 'Authorized draft text', expected: { target: { selector: '[contenteditable="true"]' }, text: 'Authorized draft text' } }, { type: 'key', effect: false, target: { selector: '[contenteditable="true"]' }, value: 'End' }] } },
      tabs: { kind: 'tabs', payload: {} },
      selectTab: { kind: 'select-tab', payload: { titleIncludes: 'Unique business page' } },
      parallelRead: { kind: 'observe', payload: { pageIds: ['COPY_PAGE_ID_1', 'COPY_PAGE_ID_2'], maxChars: 3000 } },
      crossTabBatch: { kind: 'batch', payload: { actions: [{ pageId: 'COPY_PAGE_ID_1', type: 'read', target: { selector: 'h1' } }, { pageId: 'COPY_PAGE_ID_2', type: 'fill', effect: false, target: { selector: '#draft' }, value: 'Authorized draft' }] } },
      screenshot: { kind: 'screenshot', payload: {} },
      download: { kind: 'batch', payload: { actions: [{ type: 'download', target: { selector: '#download-report' } }] } },
      upload: { kind: 'batch', payload: { actions: [{ type: 'upload', target: { selector: 'input[type="file"]' }, value: 'ABSOLUTE_USER_AUTHORIZED_FILE_PATH' }] } },
      strictIdentityStart: { goal: 'Verify a local test configuration with an optional strict identity guard', businessKind: 'site', mode: 'operations', showCursor: true,
        browserSelection: { kind: 'profile', profileId: 'REPLACE_WITH_EXPLICIT_PROFILE_ID' },
        authorization: { accountId: 'account-1', resourceIds: ['config-1'], origins: ['http://127.0.0.1:8800'], allowedActions: ['navigate', 'site.prepare', 'site.configure'], expiresAt: new Date(now + 86400000).toISOString() },
        identity: { account: { selector: '[data-account-id]', attribute: 'data-account-id' }, resource: { selector: '[data-resource-id]', attribute: 'data-resource-id' } },
        budgets: { maxRuns: 100, maxDurationMs: 3600000, maxHostCalls: 10 } },
      observe: { commandId: 'observe-1', kind: 'observe', payload: { scope: 'body', maxChars: 3000, maxItems: 30 } },
      bootstrap: { commandId: 'open-test-site-1', kind: 'batch', pageId: 'COPY_OBSERVATION_PAGE_ID', pageVersion: 'COPY_FRESH_PAGE_VERSION', payload: {
        preconditions: [{ url: 'about:blank' }], stopConditions: [], actions: [{ actionId: 'open-test-site-1:navigate', type: 'navigate', effect: false, value: 'http://127.0.0.1:8800/site', expected: { url: 'http://127.0.0.1:8800/site' } }], verify: [{ url: 'http://127.0.0.1:8800/site' }] } },
      batch: { commandId: 'save-config-1', kind: 'batch', pageId: 'COPY_FRESH_DESTINATION_PAGE_ID', pageVersion: 'COPY_FRESH_PAGE_VERSION', payload: { resourceId: 'config-1', preconditions: [{ target: { selector: '#current-value' }, text: 'old-value' }], stopConditions: [{ target: { selector: '#permission-error' }, state: 'visible' }],
        actions: [
          { actionId: 'save-config-1:fill', type: 'fill', kind: 'site.prepare', effect: false, target: { selector: '#config-value' }, value: 'approved-new-value', expected: { target: { selector: '#config-value' }, value: 'approved-new-value' } },
          { actionId: 'save-config-1:save', type: 'click', kind: 'site.configure', target: { selector: '#save-config' }, before: 'old-value', beforeTarget: { selector: '#current-value' }, proposed: 'approved-new-value', expected }
        ], verify: [expected] } },
      ack: { eventId: 'COPY_EVENT_ID' },
      decision: { eventId: 'COPY_RECEIVED_EVENT_ID', authorizationVersion: 1, summary: 'Main Agent reviewed the exact account/resource and approves this bounded change', command: { commandId: 'inspect-after-decision-1', kind: 'observe', payload: { scope: '#current-value' } } },
      reconcile: { commandId: 'readback-save-config-1', kind: 'reconcile', payload: { url: 'http://127.0.0.1:8800/site', actionIds: ['save-config-1:fill', 'save-config-1:save'], verify: [expected] } },
      notApplied: { kind: 'reconcile', payload: { actionIds: ['COPY_UNCERTAIN_ACTION_ID'], outcome: 'not-applied', reason: 'Actual application/audit evidence establishes the action was rejected before it took effect; not merely a missing success message', verify: [{ target: { selector: '#actual-submission-status' }, text: 'Rejected before submission' }] } },
      dialogAcknowledgement: { commandId: 'acknowledge-dialog-1', kind: 'control', pageId: 'COPY_FRESH_PAGE_ID', pageVersion: 'COPY_FRESH_PAGE_VERSION',
        payload: { action: 'acknowledge-dialog', reason: 'Main Agent inspected the safely dismissed dialog and current protected page; explicitly abandon only this context effect-free preparation, then observe again' } },
      dialogAcknowledgementBoundary: 'Unknown external effects still require actual same-resource reconciliation before acknowledgement. Other pages/resources/documents remain unresolved; acknowledgement never replays the interrupted group or grants permission to accept an unknown charge, delete resources or enter credentials.',
      hostAdapter: { executable: process.execPath, args: ['ABSOLUTE_PATH_TO_EXPLICITLY_CONFIGURED_HOST_ADAPTER.mjs'] },
      cursorUpdate: { showCursor: false },
      singleSendTransport: { operationStart: { singleSendTransport: true }, action: { transport: { url: 'http://127.0.0.1:8800/api/config', method: 'POST', bodySha256: 'REPLACE_WITH_SHA256_OF_EXACT_JSON_UTF8_BODY', maxBodyBytes: 65536 } }, boundary: 'Guard matches the existing UI request, never creates a second submission. An initiated durable ACK and a fresh scoped transport-forward ACK precede its sole fetch(maxRetries:0,maxRedirects:0). Stop can abort in-flight transport but cannot withdraw an effect already accepted by the server. Use current-resource readback; never retry an unknown submission.' },
      cursorBoundary: 'Omitted showCursor follows mode: operations on, controlled batch off. ops update --input toggles only this operation, never account/permission/pause. Free-form scripts do not claim full action tracking.',
      hostInput: { schemaVersion: 1, event: { id: 'event_example', operationId: 'op_example', type: 'decision', summary: 'Main Agent review required' } },
      hostReceipt: { accepted: true, eventId: 'event_example', deliveryId: 'host_delivery_example', received: true },
      decisionVersusReceipt: 'Receipt establishes delivery/reception only. Explicit ops decide is required to handle the event and continue.'
    }
  };
  const sections = ['start', 'actions', 'output', 'recovery', 'compatibility', 'all'];
  if (!section || section === 'all') return { ...schema, sections };
  const views = {
    start: { browserModel: schema.browserModel, defaults: schema.defaults, envelope: schema.envelope, examples: { start: schema.examples.start, observe: schema.examples.observe, simpleBatch: schema.examples.simpleBatch }, workflow: schema.workflow.slice(0, 5) },
    actions: { commandKinds: schema.commandKinds, actionTypes: schema.actionTypes, actionCatalog: schema.actionCatalog, targets: schema.targets, verification: schema.verification, bounds: schema.bounds },
    output: { output: schema.output },
    recovery: { safety: schema.safety, examples: { reconcile: schema.examples.reconcile, notApplied: schema.examples.notApplied, dialogAcknowledgement: schema.examples.dialogAcknowledgement } },
    compatibility: { browserModel: schema.browserModel, agentCompatibility: schema.agentCompatibility, defaults: schema.defaults }
  };
  if (!views[section]) throw Object.assign(new Error(`Unknown schema section; use ${sections.join(', ')}`), { code: 'INVALID_SCHEMA_SECTION' });
  return { schemaVersion: schema.schemaVersion, section, sections, ...views[section] };
}
