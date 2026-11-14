export function operationsSchema({ now = Date.now() } = {}) {
  const expected = { target: { selector: '#current-value' }, text: 'approved-new-value' };
  return {
    schemaVersion: 1,
    executionModes: ['batch', 'operations'], selectionPolicy: 'auto',
    precedence: 'Explicit task mode overrides the Profile default for this task only; auto uses Skill recommendation, declared intent, then finite batch compatibility default.',
    safety: [
      'Account backends default to supported local browser-use. Without its host adapter, choose between connecting that adapter or explicitly authorizing a named Task Master Profile; no implicit fallback.',
      'This Profile example is for an explicitly selected isolated/local test Profile, not permission to use an existing account.',
      'Observe first; use returned pageId/pageVersion. Batches require current identity, unique targets, preconditions, positive verification and stable action IDs.',
      'Unknown/initiated effects require readback; never change action IDs to retry. Takeover is a separate pause lock, not a mode.',
      'No native session-ended/app-closed host wake-up is claimed without a configured and verified adapter.'
    ],
    workflow: [
      'taskmaster profiles create "Isolated operations test"; taskmaster profiles list --json. Explicitly select the approved Profile ID.',
      'Replace placeholders, exact origin, identity selectors, expiry and allowed effects with the approved scope; taskmaster ops start --input @start.json --json.',
      'taskmaster ops command OP_ID --input @observe.json --json; taskmaster ops get OP_ID --command observe-1 --json. Compact get retains status/pause/pending/unknown safety context.',
      'Copy returned pageId/pageVersion into bootstrap, then observe the destination again before a verified action group.',
      'taskmaster ops events OP_ID --wait-ms 30000 --json; taskmaster ops ack OP_ID --input @ack.json; taskmaster ops decide OP_ID --input @decision.json.',
      'On unknown effects, obtain uncertain action IDs and their original expected results; reconcile performs only readback navigation/refresh, never resubmission.',
      'ops pause|takeover OP_ID prevents automation. Resume is explicit and requires fresh observation; revoked/expired permission cannot resume.',
      'ops stop-all stops operations only. Original finite script run/follow commands remain supported.'
    ],
    commandKinds: ['observe', 'batch', 'wait', 'screenshot', 'tabs', 'select-tab', 'reconcile'],
    envelope: { commandId: 'stable-unique-id', kind: 'observe', pageId: 'COPY_FRESH_PAGE_ID', pageVersion: 'COPY_FRESH_PAGE_VERSION', payload: {} },
    bounds: { commandBytes: 131072, maxBatchActions: 16, maxActionGroupTimeoutMs: 60000, eventLongPollMaxMs: 30000, readOnlyParallelScopes: 4 },
    examples: {
      start: { goal: 'Verify a local test configuration', businessKind: 'site', mode: 'operations', skillMode: 'operations',
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
      hostAdapter: { executable: process.execPath, args: ['ABSOLUTE_PATH_TO_EXPLICITLY_CONFIGURED_HOST_ADAPTER.mjs'] },
      hostInput: { schemaVersion: 1, event: { id: 'event_example', operationId: 'op_example', type: 'decision', summary: 'Main Agent review required' } },
      hostReceipt: { accepted: true, eventId: 'event_example', deliveryId: 'host_delivery_example', received: true },
      decisionVersusReceipt: 'Receipt establishes delivery/reception only. Explicit ops decide is required to handle the event and continue.'
    }
  };
}
