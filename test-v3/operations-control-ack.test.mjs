import assert from 'node:assert/strict';
import test from 'node:test';
import { acknowledgeOperationControl } from '../src/runtime/task-worker.mjs';

test('Worker cursor ACK waits for actual async handler application', async () => {
  const sent = []; let complete;
  const applied = new Promise((resolve) => { complete = resolve; });
  const request = { requestId: 'cursor-request', control: { action: 'cursor', visible: false } };
  const result = acknowledgeOperationControl(request, { listeners: new Set([async () => { await applied; return { cursorEnabled: false }; }]), sendMessage: (message) => sent.push(message) });
  await Promise.resolve(); assert.equal(sent.length, 0);
  complete(); await result;
  assert.equal(sent.length, 1); assert.equal(sent[0].accepted, true); assert.equal(sent[0].requestId, request.requestId); assert.equal(sent[0].result.cursorEnabled, false);
});

test('Worker refuses missing, failed or mismatched cursor application instead of acknowledging success', async () => {
  for (const listeners of [new Set(), new Set([async () => { throw new Error('Renderer unavailable'); }]), new Set([async () => ({ cursorEnabled: false })])]) {
    const sent = [];
    const result = await acknowledgeOperationControl({ requestId: 'request', control: { action: 'cursor', visible: true } }, { listeners, sendMessage: (message) => sent.push(message) });
    assert.equal(result.accepted, false); assert.equal(sent[0].accepted, false); assert.ok(sent[0].error.code);
  }
});
