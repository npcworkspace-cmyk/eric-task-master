import assert from 'node:assert/strict';
import test from 'node:test';
import { readLiveOperationLedger } from '../scripts/acceptance-live-chaos.mjs';

const operation = { id: 'op-reader', status: 'running', authorization: { version: 1 }, actions: [{ actionId: 'action-1', status: 'unknown' }], commands: [{ commandId: 'command-1', reply: { status: 'unknown' } }] };

test('live acceptance reads current action/command materialization and every event page through read-only CLI calls', async () => {
  const calls = [], events = Array.from({ length: 405 }, (_, index) => ({ id: `event-${index + 1}`, operationId: operation.id, sequence: index + 1, state: index === 404 ? 'handled' : 'pending' }));
  const ledger = await readLiveOperationLedger(async args => {
    calls.push(args);
    if (args[1] === 'get') return structuredClone(operation);
    const after = Number(args.at(-1)), rows = events.filter(event => event.sequence > after).slice(0, 200);
    return { events: rows, nextCursor: rows.at(-1)?.sequence || after };
  }, operation.id);
  assert.equal(ledger.operations[0].authorization.version, 1);
  assert.deepEqual(ledger.actions, operation.actions);
  assert.deepEqual(ledger.commands, operation.commands);
  assert.deepEqual(ledger.events, events);
  assert.deepEqual(calls.map(args => args[1]), ['get', 'events', 'events', 'events', 'events']);
  assert.deepEqual(calls.filter(args => args[1] === 'events').map(args => args.at(-1)), ['0', '200', '400', '405']);
});

test('live acceptance refuses unavailable or cross-operation ledger evidence', async () => {
  await assert.rejects(readLiveOperationLedger(async () => ({ error: { code: 'MANAGER_UNREACHABLE' } }), operation.id), /unavailable/u);
  await assert.rejects(readLiveOperationLedger(async args => args[1] === 'get' ? operation : { events: [{ id: 'wrong', operationId: 'other', sequence: 1 }], nextCursor: 1 }, operation.id), /scope/u);
});

test('live acceptance cannot silently truncate a stuck or inconsistent event cursor', async () => {
  for (const page of [
    { events: [{ operationId: operation.id, sequence: 0 }], nextCursor: 0 },
    { events: [{ operationId: operation.id, sequence: 1 }], nextCursor: 3 },
    { events: [], nextCursor: -1 }
  ]) await assert.rejects(readLiveOperationLedger(async args => args[1] === 'get' ? operation : page, operation.id), /advance|cursor|invalid/u);
});
