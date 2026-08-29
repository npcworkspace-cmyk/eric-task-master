import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PublicTaskFailure,
  createTaskFailureFacade,
  sanitizePublicTaskFailure
} from '../src/lib/public-task-failure.mjs';
import { publicTask as publicManagerTask } from '../src/contracts.mjs';
import { publicTask as publicMcpTask } from '../src/mcp/public-view.mjs';

test('typed public task failures keep only bounded actionable fields', () => {
  const failure = new PublicTaskFailure({
    category: 'input',
    code: 'INPUT_RELATION_INVALID',
    publicMessage: 'The requested count exceeds the supplied source list.',
    fields: [{
      path: 'input.itemCount',
      reason: 'Must not exceed input.sources.length.',
      expectedType: 'integer',
      receivedType: 'string'
    }],
    nextAction: 'Reduce itemCount or provide more sources, then retry once.'
  });
  assert.equal(failure.code, 'INPUT_RELATION_INVALID');
  assert.deepEqual(failure.publicFailure.fields, [
    {
      path: 'input.itemCount',
      reason: 'Must not exceed input.sources.length.',
      expectedType: 'integer',
      receivedType: 'string'
    }
  ]);
});

test('failure facade throws the typed contract while arbitrary objects stay private', () => {
  const facade = createTaskFailureFacade();
  assert.throws(() => facade.raise({
    category: 'precondition',
    code: 'SOURCE_NOT_READY',
    publicMessage: 'The source is not ready for this operation.',
    fields: [],
    nextAction: 'Inspect the source state and retry after it is ready.'
  }), { name: 'PublicTaskFailure', code: 'SOURCE_NOT_READY' });
  assert.equal(sanitizePublicTaskFailure({ code: 'SOURCE_NOT_READY', publicMessage: 'raw' }), null);
  assert.equal(sanitizePublicTaskFailure({
    category: 'input',
    code: 'bad-code',
    publicMessage: 'No',
    nextAction: 'No'
  }), null);
});

test('public task failure text is redacted before it can cross a process boundary', () => {
  const normalized = sanitizePublicTaskFailure({
    category: 'provider',
    code: 'PROVIDER_REJECTED',
    publicMessage: 'Request failed with token=super-secret at C:\\private\\task.json',
    fields: [{ path: 'input.endpoint', reason: 'https://example.com/a?token=super-secret rejected it' }],
    nextAction: 'Check token=super-secret and retry.'
  });
  assert.ok(normalized);
  assert.equal(JSON.stringify(normalized).includes('super-secret'), false);
  assert.equal(JSON.stringify(normalized).includes('C:\\private'), false);
  assert.equal(JSON.stringify(normalized).includes('?token='), false);
});

test('typed public failures redact high-confidence opaque credentials in every public text slot', () => {
  const secrets = [
    `ghp_${'a'.repeat(36)}`,
    `github_pat_${'A1_'.repeat(12)}`,
    `sk-proj-${'b'.repeat(32)}`,
    `sk-${'c'.repeat(32)}`,
    `sk-ant-api03-${'d'.repeat(32)}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-value',
    'AKIAIOSFODNN7EXAMPLE',
    `xoxb-${'1'.repeat(12)}-${'e'.repeat(24)}`,
    `123456789:${'A'.repeat(35)}`
  ];
  for (const secret of secrets) {
    const normalized = sanitizePublicTaskFailure({
      category: 'provider',
      code: 'PROVIDER_REJECTED',
      publicMessage: `Provider rejected value ${secret}`,
      fields: [{ path: 'provider.response', reason: `Raw response contained ${secret}` }],
      nextAction: `Remove ${secret} and retry.`,
      providerPayload: { raw: secret }
    });
    assert.ok(normalized);
    const source = JSON.stringify(normalized);
    assert.equal(source.includes(secret), false, `credential leaked: ${secret.slice(0, 12)}`);
    assert.match(source, /\[REDACTED_CREDENTIAL\]/u);
    assert.equal(source.includes('providerPayload'), false);
  }
});

test('opaque credential filtering stays conservative and field count fails closed', () => {
  const benign = sanitizePublicTaskFailure({
    category: 'data',
    code: 'DATA_NOT_READY',
    publicMessage: 'Keep sketch-project, AKIA-short, and xoxb-demo as useful labels.',
    fields: [],
    nextAction: 'Wait for the documented provider state, then retry.'
  });
  assert.match(benign.publicMessage, /sketch-project/u);
  assert.match(benign.publicMessage, /AKIA-short/u);
  assert.match(benign.publicMessage, /xoxb-demo/u);
  assert.equal(sanitizePublicTaskFailure({
    category: 'input',
    code: 'TOO_MANY_FIELDS',
    publicMessage: 'Too many fields.',
    fields: Array.from({ length: 9 }, (_, index) => ({ path: `input.items[${index}]`, reason: 'Invalid.' })),
    nextAction: 'Correct the input.'
  }), null);
});

test('MCP task projection exposes the typed failure but never a raw arbitrary task error', () => {
  const typed = publicMcpTask({
    id: 'task_typed_failure',
    state: 'failed',
    error: {
      code: 'SOURCE_LIMIT_INVALID',
      message: 'private implementation detail',
      publicFailure: {
        category: 'input',
        code: 'SOURCE_LIMIT_INVALID',
        publicMessage: 'The requested item count is invalid.',
        fields: [{ path: 'input.itemCount', reason: 'Must be an integer.', expectedType: 'integer', receivedType: 'string' }],
        nextAction: 'Correct itemCount and retry once.'
      }
    }
  });
  assert.deepEqual(typed.error, {
    code: 'SOURCE_LIMIT_INVALID',
    category: 'input',
    message: 'The requested item count is invalid.',
    fields: [{ path: 'input.itemCount', reason: 'Must be an integer.', expectedType: 'integer', receivedType: 'string' }],
    nextAction: 'Correct itemCount and retry once.'
  });
  const generic = publicMcpTask({
    id: 'task_generic_failure',
    state: 'failed',
    error: { code: 'PROVIDER_PRIVATE_FAILURE', message: 'secret provider response' }
  });
  assert.equal(generic.error.message.includes('secret provider response'), false);
});

test('Manager and MCP task projections share one strict idempotent failure view', () => {
  const unknownSecret = 'totally-unknown-provider-secret-DoNotExpose-918273645';
  const rawTypedTask = {
    id: 'task_typed_public_failure',
    state: 'failed',
    error: {
      code: 'SOURCE_LIMIT_INVALID',
      message: `private provider response ${unknownSecret}`,
      stack: `Error at C:\\private\\worker.mjs:4 ${unknownSecret}`,
      providerPayload: { raw: unknownSecret },
      publicFailure: {
        category: 'input',
        code: 'SOURCE_LIMIT_INVALID',
        publicMessage: 'The requested item count is invalid.',
        fields: [{ path: 'input.itemCount', reason: 'Must be an integer.' }],
        nextAction: 'Correct itemCount and retry once.'
      }
    }
  };
  const expectedTyped = {
    code: 'SOURCE_LIMIT_INVALID',
    category: 'input',
    message: 'The requested item count is invalid.',
    fields: [{ path: 'input.itemCount', reason: 'Must be an integer.' }],
    nextAction: 'Correct itemCount and retry once.'
  };
  const managerTyped = publicManagerTask(rawTypedTask);
  assert.deepEqual(managerTyped.error, expectedTyped);
  assert.deepEqual(publicManagerTask(managerTyped).error, expectedTyped);
  assert.deepEqual(publicMcpTask(rawTypedTask).error, expectedTyped);
  assert.deepEqual(publicMcpTask(managerTyped).error, expectedTyped);
  assert.equal(JSON.stringify(managerTyped).includes(unknownSecret), false);

  const rawGenericTask = {
    id: 'task_generic_public_failure',
    state: 'failed',
    error: {
      code: 'PROVIDER_PRIVATE_FAILURE',
      message: `raw upstream ${unknownSecret}`,
      stack: `Error at /home/private/worker.mjs ${unknownSecret}`,
      details: { response: unknownSecret },
      providerPayload: { raw: unknownSecret }
    }
  };
  const managerGeneric = publicManagerTask(rawGenericTask);
  assert.deepEqual(managerGeneric.error, {
    code: 'PROVIDER_PRIVATE_FAILURE',
    message: 'Task failed; inspect its state, progress, checkpoint, and diagnostic artifacts.'
  });
  assert.deepEqual(publicMcpTask(rawGenericTask).error, managerGeneric.error);
  assert.equal(JSON.stringify(managerGeneric).includes(unknownSecret), false);
  assert.equal('providerPayload' in managerGeneric.error, false);
  assert.equal(publicManagerTask({ id: 'invalid', state: 'failed', error: {
    code: 'bad-code', message: unknownSecret, providerPayload: { raw: unknownSecret }
  } }).error, undefined);
});
