import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveValue } from '../src/lib/redaction.mjs';

test('structured cookie and header values never enter Manager-owned state', () => {
  const input = {
    cookiesFromPage: [
      { name: 'reddit_session', value: 'COOKIE_SECRET', domain: '.reddit.com', path: '/', httpOnly: true }
    ],
    diagnostic: { name: 'Authorization', value: 'Bearer HEADER_SECRET' },
    ordinary: { name: 'result', value: 'keep-me' }
  };

  const redacted = redactSensitiveValue(input);
  assert.equal(redacted.cookiesFromPage[0].value, '[REDACTED]');
  assert.equal(redacted.diagnostic.value, '[REDACTED]');
  assert.equal(redacted.ordinary.value, 'keep-me');
  assert.doesNotMatch(JSON.stringify(redacted), /COOKIE_SECRET|HEADER_SECRET/u);
});

test('structured redaction never silently hides an item-count truncation', () => {
  const array = Array.from({ length: 1_001 }, (_, index) => index);
  const redactedArray = redactSensitiveValue(array);
  assert.equal(redactedArray.length, 1_001);
  assert.deepEqual(redactedArray.at(-1), {
    __taskMasterTruncated: { kind: 'array', includedItems: 1_000, omittedItems: 1 }
  });

  const object = Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [`field${index}`, index]));
  const redactedObject = redactSensitiveValue(object);
  assert.deepEqual(redactedObject.__taskMasterTruncated, {
    kind: 'object', includedItems: 1_000, omittedItems: 1
  });
});
