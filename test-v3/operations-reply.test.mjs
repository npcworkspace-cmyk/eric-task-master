import assert from 'node:assert/strict';
import test from 'node:test';
import { compactOperationsReply } from '../src/lib/operations-reply.mjs';

const page = { pageId: 'page_1', pageVersion: '1:doc:2', url: 'https://fixture.test/work', title: 'Workspace' };
const scene = items => ({ ...page, items, total: items.length, offset: 0, omitted: { before: 0, after: 0, textCharacters: 0 }, continuation: null });

test('wire compaction retains decisions and executable refs without mutating full evidence', () => {
  const full = { status: 'confirmed', needsDecision: false, ...page, unresolvedActions: [], result: { observation: scene([
    { ref: 'r1', selector: 'html > body:nth-of-type(1)', tag: 'body', text: 'SaveNotes', role: null, disabled: false, checked: false },
    { ref: 'r2', selector: 'html > body:nth-of-type(1) > button:nth-of-type(1)', tag: 'button', text: 'Save', role: null, disabled: false, checked: false },
    { ref: 'r3', selector: 'html > body:nth-of-type(1) > textarea:nth-of-type(1)', role: 'textbox', name: 'Notes', value: '', editable: true },
    { ref: 'r4', selector: '#agreed', role: 'checkbox', name: 'Agreed', checked: false }
  ]) } };
  const before = structuredClone(full), compact = compactOperationsReply(full);
  assert.deepEqual(full, before);
  assert.equal(compact.needsDecision, false);
  assert.deepEqual(compact.unresolvedActions, []);
  assert.equal(compact.result.observation.pageId, undefined);
  assert.equal(compact.pageVersion, page.pageVersion);
  const [button, notes, checkbox] = compact.result.observation.items;
  assert.equal(compact.result.observation.omitted.redundant, 1);
  assert.deepEqual(button, { ref: 'r2', role: 'button', name: 'Save' });
  assert.equal(notes.value, '');
  assert.equal(checkbox.checked, false);
  assert.equal(JSON.stringify(compact).includes('nth-of-type'), false);
});

test('routine confirmed command drops only recoverable wrappers and no-check receipts, with full truth unchanged', () => {
  const full = { ok: true, commandId: 'cmd_1', status: 'confirmed', ...page, operationId: 'op_1', taskId: 'task_1', operationStatus: 'running',
    needsDecision: false, reason: null, evidenceRef: null, pending: null, pauseReason: null, unresolvedActions: [], unresolvedActionCount: 0,
    identityStatus: { scope: 'profile', websiteAccountVerified: false }, result: { actions: [{ actionId: 'a1', status: 'confirmed' }], elapsedMs: 123,
      verification: { matched: null, businessResultVerified: false }, observation: scene([{ ref: 'r1', tag: 'p', text: 'Actual state' }]) } };
  const before = structuredClone(full), compact = compactOperationsReply(full);
  assert.deepEqual(full, before);
  assert.equal(compact.ok, true);
  assert.equal(compact.commandId, 'cmd_1');
  assert.equal(compact.status, 'confirmed');
  assert.equal(compact.pageId, page.pageId);
  assert.equal(compact.pageVersion, page.pageVersion);
  assert.equal(compact.identityStatus, undefined, 'absent default identity is not website-account-verified');
  for (const key of ['operationId', 'taskId', 'operationStatus', 'needsDecision', 'reason', 'evidenceRef', 'pending', 'pauseReason', 'unresolvedActions', 'unresolvedActionCount']) assert.equal(Object.hasOwn(compact, key), false, key);
  assert.deepEqual(compact.result, { observation: { items: [{ ref: 'r1', text: 'Actual state' }] } });
});

test('positive action/business checks, meaningful results and any warning or paused/unknown state stay explicit', () => {
  const make = () => ({ ok: true, commandId: 'cmd_1', status: 'confirmed', ...page, operationId: 'op_1', taskId: 'task_1', operationStatus: 'running',
    needsDecision: false, reason: null, unresolvedActions: [], unresolvedActionCount: 0, result: {
      actions: [{ actionId: 'a1', status: 'confirmed' }, { actionId: 'a2', status: 'confirmed', result: { expectedMatched: true, evidenceRef: 'proof.json' } }],
      verification: { matched: true, businessResultVerified: true }, elapsedMs: 123, observation: scene([{ ref: 'r1', role: 'status', name: 'Result', text: 'Saved once' }]) } });
  const verified = compactOperationsReply(make());
  assert.deepEqual(verified.result.verification, { matched: true, businessResultVerified: true });
  assert.equal(verified.result.actionCount, 2);
  assert.deepEqual(verified.result.actions, [{ actionId: 'a2', status: 'confirmed', result: { expectedMatched: true, evidenceRef: 'proof.json' } }]);
  for (const patch of [{ warning: 'Storage pressure' }, { needsDecision: true }, { operationStatus: 'paused', pauseReason: 'manual' }, { status: 'unknown' }, { revoked: true }, { unresolvedActions: [{ actionId: 'a3', status: 'unknown' }], unresolvedActionCount: 1 }]) {
    const full = { ...make(), ...patch }, compact = compactOperationsReply(full);
    assert.equal(compact.operationId, 'op_1');
    assert.equal(compact.taskId, 'task_1');
    assert.equal(compact.operationStatus, full.operationStatus);
    assert.equal(compact.result.elapsedMs, 123);
  }
});

test('operation start/get DTO identity and zero unresolved counts are not routine command defaults', () => {
  const dto = { id: 'op_1', operationId: 'op_1', taskId: 'task_1', status: 'running', unresolvedActions: [], unresolvedActionCount: 0, profileId: 'profile_1', fullEvidence: { detail: 'full' } };
  assert.deepEqual(compactOperationsReply(dto), dto);
});

test('only exact healthy current-command unverified profile identity is omitted, never verified/extra/warning/DTO identity', () => {
  const make = () => ({ ok: true, commandId: 'cmd_1', status: 'confirmed', ...page, operationId: 'op_1', operationStatus: 'running',
    identityStatus: { scope: 'profile', websiteAccountVerified: false }, result: { observation: scene([{ ref: 's', role: 'status', text: 'Saved once' }]) } });
  assert.equal(compactOperationsReply(make()).identityStatus, undefined);
  for (const identityStatus of [{ scope: 'profile', websiteAccountVerified: true }, { scope: 'account', websiteAccountVerified: false },
    { scope: 'profile', websiteAccountVerified: false, warning: 'Identity requires attention' }, { scope: 'profile', websiteAccountVerified: false, accountId: null }]) {
    assert.deepEqual(compactOperationsReply({ ...make(), identityStatus }).identityStatus, identityStatus);
  }
  for (const patch of [{ warning: 'Storage warning' }, { reason: 'attention' }, { needsDecision: true }, { operationStatus: 'paused' }]) {
    assert.deepEqual(compactOperationsReply({ ...make(), ...patch }).identityStatus, make().identityStatus);
  }
  const dto = { id: 'op_1', status: 'running', identityStatus: make().identityStatus, profileId: 'profile_1' };
  assert.deepEqual(compactOperationsReply(dto).identityStatus, dto.identityStatus);
});

test('positive wait checks stay explicit without mechanical siblings or timings, while negative checks are never routine', () => {
  const full = { ok: true, commandId: 'cmd_wait', status: 'confirmed', ...page, operationId: 'op_1', taskId: 'task_1', operationStatus: 'running',
    result: { actions: [{ actionId: 'open', status: 'confirmed' }, { actionId: 'wait', matched: true, elapsedMs: 450 }, { actionId: 'close', status: 'confirmed' }], elapsedMs: 600 } };
  const compact = compactOperationsReply(full);
  assert.equal(compact.operationId, undefined);
  assert.deepEqual(compact.result, { actions: [{ actionId: 'wait', matched: true }], actionCount: 3 });
  const failed = structuredClone(full);
  failed.result.actions[1].matched = false;
  assert.equal(compactOperationsReply(failed).operationId, 'op_1');
  assert.equal(compactOperationsReply(failed).result.actions[1].elapsedMs, 450);
});

test('identical current value/text is represented once without collapsing separate actionable refs', () => {
  const compact = compactOperationsReply({ observation: scene([
    { ref: 'note', tag: 'textarea', role: 'textbox', name: 'Note', text: 'Actual note', value: 'Actual note', editable: true, textRange: { start: 0, end: 11, total: 11 } },
    { ref: 'save1', role: 'button', name: 'Save', text: 'Save' }, { ref: 'save2', role: 'button', name: 'Save', text: 'Save' },
    { ref: 'empty-context', tag: 'p', text: '' }
  ]) });
  assert.equal(compact.observation.items[0].value, 'Actual note');
  assert.equal(compact.observation.items[0].text, undefined);
  assert.deepEqual(compact.observation.items.slice(1).map(item => item.ref), ['save1', 'save2', 'empty-context']);
});

test('matching text/value prefixes are never deduplicated when either field is partial or continued', () => {
  const text = 'same visible prefix';
  for (const field of ['text', 'value']) {
    const range = { start: 0, end: text.length, total: text.length + 100 };
    const item = { ref: 'note', role: 'textbox', name: 'Note', text, value: text, [`${field}Range`]: range,
      [`${field}Continuation`]: { ref: 'note', detail: 'full', fields: [field], [`${field}Offset`]: range.end, maxItems: 1 } };
    const compact = compactOperationsReply({ observation: scene([item]) });
    assert.equal(compact.observation.items[0].text, text);
    assert.equal(compact.observation.items[0].value, text);
    assert.equal(compact.observation.items[0][`${field}Range`].total, range.total);
    assert.equal(compact.observation.items[0][`${field}Continuation`][`${field}Offset`], range.end);
  }
});

test('count limits report exact omissions and a fresh continuation, including delta scenes', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ ref: `r${i}`, tag: 'button', text: `Action ${i}` }));
  const compact = compactOperationsReply({ observation: { ...scene(items), total: 20, offset: 4, omitted: { before: 4, after: 4, textCharacters: 0 } } }, { maxItems: 3 });
  assert.equal(compact.observation.items.length, 3);
  assert.equal(compact.observation.omitted.before, 4);
  assert.equal(compact.observation.omitted.after, 13);
  assert.deepEqual(compact.observation.continuation, { offset: 7, detail: 'full' });
  const delta = compactOperationsReply({ observation: { ...scene(items), delta: true, unchanged: 80 } }, { maxItems: 2 });
  assert.equal(delta.observation.unchanged, 80);
  assert.equal(delta.observation.continuation.offset, 0, 'truncated deltas must restart a full scene, not pretend changed-item offsets are page offsets');
  const rootSkipped = compactOperationsReply({ observation: scene([{ ref: 'body', tag: 'body', text: '' }, ...items]) }, { maxItems: 1 });
  assert.equal(rootSkipped.observation.items.length, 1);
  assert.equal(rootSkipped.observation.omitted.redundant, 1);
  assert.equal(rootSkipped.observation.continuation.offset, 2, 'the next source position includes the suppressed root slot');
});

test('direct observe results hoist page metadata but business item payloads are not mistaken for observations', () => {
  const reply = compactOperationsReply({ status: 'confirmed', result: scene([{ ref: 'button', tag: 'button', text: 'Save' }]), business: { items: [{ ref: 'invoice', selector: 'a business field', value: 4 }] } });
  assert.equal(reply.pageId, page.pageId);
  assert.equal(reply.result.pageId, undefined);
  assert.deepEqual(reply.business, { items: [{ ref: 'invoice', selector: 'a business field', value: 4 }] });
});

test('strict JSON budget truncates text with exact mode/range/ref continuation', () => {
  const text = '\\"\n'.repeat(1800);
  const total = 100 + text.length;
  const full = { commandId: 'cmd_long', status: 'confirmed', observation: scene([{ ref: 'rules', selector: '#rules', tag: 'p', text, textMode: 'own', textRange: { start: 100, end: total, total } }]) };
  const compact = compactOperationsReply(full, { maxChars: 1100 });
  assert.ok(JSON.stringify(compact).length <= 1100);
  const item = compact.observation.items[0];
  assert.ok(item.text.length > 0 && item.text.length < text.length);
  assert.equal(item.textRange.end, 100 + item.text.length);
  assert.equal(item.textRange.total, total);
  assert.deepEqual(item.textContinuation, { ref: 'rules', detail: 'full', fields: ['text'], textMode: 'own', textOffset: item.textRange.end, maxItems: 1, textPageId: page.pageId, textPageVersion: page.pageVersion });
  assert.equal(compact.observation.omitted.textCharacters, total - item.text.length);
});

test('already-partial text, name and value chunks keep validated offsets or require full observation continuation', () => {
  for (const field of ['text', 'name', 'value']) {
    const source = 'captured prefix '.repeat(350);
    const range = { start: 0, end: source.length, total: source.length + 1000 };
    const continuation = { ref: 'partial', detail: 'full', fields: [field], [`${field}Offset`]: range.end, maxItems: 1 };
    const partial = { ref: 'partial', tag: field === 'text' ? 'p' : 'input', [field]: source, [`${field}Range`]: range, [`${field}Continuation`]: continuation,
      ...(field === 'name' ? { nameExact: false } : {}) };
    const full = { commandId: 'already_executed', status: 'confirmed', observation: scene([{ ref: 'ready', tag: 'button', text: 'Inspect' }, partial]) };
    const compact = compactOperationsReply(full);
    assert.deepEqual(compact.observation.items.map(item => item.ref), ['ready']);
    assert.equal(compact.observation.omitted.after, 1);
    assert.deepEqual(compact.observation.continuation, { offset: 1, detail: 'full' });
    const fits = compactOperationsReply(full, { maxChars: 16000 });
    const retained = fits.observation.items.find(item => item.ref === 'partial');
    assert.equal(retained[field], source);
    assert.equal(retained[`${field}Range`].end, range.end);
    assert.equal(retained[`${field}Continuation`][`${field}Offset`], range.end);
    assert.throws(() => compactOperationsReply({ commandId: 'already_executed', status: 'confirmed', observation: scene([partial]) }), error => {
      assert.equal(error.code, 'CONTEXT_INSUFFICIENT');
      assert.equal(error.compactReceipt.commandId, 'already_executed');
      assert.equal(error.compactReceipt.status, 'confirmed');
      assert.equal(error.compactReceipt.fullReceiptRequired, true);
      return true;
    });
  }
});

test('modal, errors, rules, warnings and unknown safety fields survive recursive DTO/event compaction', () => {
  const nested = scene([
    { ref: 'dialog', role: 'dialog', name: 'Delete workspace', modal: true, text: 'This cannot be undone.' },
    { ref: 'alert', role: 'alert', text: 'Permission denied.' },
    { ref: 'rules', tag: 'p', text: 'Rule '.repeat(400), textRange: { start: 0, end: 2000, total: 2000 } }
  ]);
  const compact = compactOperationsReply({ operationId: 'op_1', status: 'running', automationPaused: true, pauseReason: 'manual',
    warning: 'Storage needs attention', unresolvedActions: [{ actionId: 'a1', status: 'unknown' }],
    commandCount: 300, fullEvidence: { detail: 'full' }, commands: [{ id: 'c1', reply: { status: 'stopped', needsDecision: true, reason: 'ACTION_FAILED', result: { code: 'ACTION_FAILED', message: 'Native wait failed', details: { phase: 'native-action' } }, observation: nested } }],
    events: [{ sequence: 7, payload: { observation: scene([{ ref: 'e1', tag: 'button', text: 'Inspect' }]), safety: { blocked: true } } }]
  }, { maxChars: 5000 });
  assert.equal(compact.commands[0].reply.result.details.phase, 'native-action');
  assert.equal(compact.commands[0].reply.observation.items[0].modal, true);
  assert.equal(compact.commands[0].reply.observation.items[1].text, 'Permission denied.');
  assert.equal(compact.events[0].payload.safety.blocked, true);
  assert.deepEqual(compact.unresolvedActions, [{ actionId: 'a1', status: 'unknown' }]);
  assert.equal(compact.pauseReason, 'manual');
  assert.equal(compact.commandCount, 300);
  assert.equal(compact.warning, 'Storage needs attention');
});

test('compact labelled status and alert expose state text as well as accessible names', () => {
  const compact = compactOperationsReply({ status: 'confirmed', observation: scene([
    { ref: 'status', role: 'status', name: '保存状态', text: '尚未保存；提交次数：0' },
    { ref: 'alert', role: 'alert', name: '校验结果', text: '备注不匹配，请重新核对' }
  ]) });
  assert.deepEqual(compact.observation.items, [
    { ref: 'status', role: 'status', name: '保存状态', text: '尚未保存；提交次数：0' },
    { ref: 'alert', role: 'alert', name: '校验结果', text: '备注不匹配，请重新核对' }
  ]);
});

test('secret keys, private item values and bearer/query secrets never reach compact wire', () => {
  const compact = compactOperationsReply({ managerToken: 'manager-secret', status: 'confirmed', observation: scene([
    { ref: 'private', role: 'textbox', name: 'Private field', text: 'hidden-note-123', value: 'hidden-value-456', private: true },
    { ref: 'public', role: 'textbox', name: 'Notes', value: 'token=private-token-789' }
  ]), details: { authorization: 'Bearer credential-abc', message: 'Bearer bearer-secret-xyz', url: 'https://fixture.test/?access_token=query-secret-xyz' } });
  const wire = JSON.stringify(compact);
  for (const secret of ['manager-secret', 'hidden-note-123', 'hidden-value-456', 'private-token-789', 'credential-abc', 'bearer-secret-xyz', 'query-secret-xyz']) assert.equal(wire.includes(secret), false, secret);
  assert.equal(compact.observation.items[0].value, '[REDACTED]');
});

test('an oversized safety envelope preserves the actual receipt rather than inventing an unexecuted error', () => {
  const full = { operationId: 'op_1', commandId: 'cmd_1', status: 'unknown', needsDecision: true,
    unresolvedActions: Array.from({ length: 500 }, (_, i) => ({ actionId: `action_${i}`, status: 'unknown' })), warning: 'w'.repeat(3000) };
  const before = structuredClone(full);
  assert.throws(() => compactOperationsReply(full, { maxChars: 700 }), error => {
    assert.equal(error.code, 'CONTEXT_INSUFFICIENT');
    assert.equal(error.compactReceipt.status, 'unknown');
    assert.equal(error.compactReceipt.commandId, 'cmd_1');
    assert.equal(error.compactReceipt.unresolvedActionCount, 500);
    assert.equal(error.compactReceipt.reason, 'OUTPUT_CONTEXT_INSUFFICIENT');
    assert.equal(error.compactReceipt.fullReceiptRequired, true);
    return true;
  });
  assert.deepEqual(full, before);
});

test('selector-only peer observations keep their only target path and reject invalid bounds', () => {
  const compact = compactOperationsReply({ observation: scene([{ selector: '#peer-save', tag: 'button', text: 'Save peer' }]) });
  assert.equal(compact.observation.items[0].selector, '#peer-save');
  assert.throws(() => compactOperationsReply({}, { maxChars: Infinity }), { code: 'INVALID_COMMAND' });
  assert.throws(() => compactOperationsReply({}, { maxItems: 201 }), { code: 'INVALID_COMMAND' });
});
