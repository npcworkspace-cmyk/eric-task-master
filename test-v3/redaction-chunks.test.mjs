import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveText, sensitiveTextRules, sliceRedactedText } from '../src/lib/redaction.mjs';

export const SECRET_RULE_TEXT = 'Intro\nAuthorization: Bearer auth-value-ABC\nCookie: sid=cookie-value-ABC; user=another-value\nCookie:\nservice-api-token=prefix-value-ABC\npassword="named-value-ABC"\nhttps://fixture.test/?access_token=query-value-ABC&x=1\nBearer bearer-value-ABC\nEnd';

test('serializable browser text rules use all six canonical redaction patterns in the same order', () => {
  const rules = sensitiveTextRules();
  assert.equal(rules.length, 6);
  let actual = SECRET_RULE_TEXT;
  for (const rule of rules) actual = actual.replace(new RegExp(rule.source, rule.flags), rule.replacement);
  assert.equal(actual, redactSensitiveText(SECRET_RULE_TEXT));
});

test('atomic protected spans survive a second redaction at chunk targets 1, 8 and 16', () => {
  const source = redactSensitiveText(SECRET_RULE_TEXT);
  for (const target of [1, 8, 16]) {
    let offset = 0, reconstructed = '', pieces = 0;
    while (offset < source.length) {
      const piece = sliceRedactedText(source, offset, target);
      assert.ok(piece.length > 0, 'a returned continuation must make source progress');
      assert.equal(redactSensitiveText(piece), piece, JSON.stringify({ target, offset, piece }));
      reconstructed += piece;
      offset += piece.length;
      assert.ok(++pieces < 300);
    }
    assert.equal(reconstructed, source);
    assert.equal(reconstructed.includes('value-ABC'), false);
  }
});

test('generated cuts do not invent secret starts inside identifiers or mid-line Cookie names', () => {
  const source = 'AAAAAAmytoken=hello\nMidline XCookie: ordinary text\nEnd';
  assert.equal(redactSensitiveText(source), source);
  for (const target of [1, 8, 16]) {
    let offset = 0, reconstructed = '', pieces = 0;
    while (offset < source.length) {
      const part = sliceRedactedText(source, offset, target);
      assert.ok(part.length > 0);
      assert.equal(redactSensitiveText(part), part);
      reconstructed += part; offset += part.length;
      assert.ok(++pieces < 100);
    }
    assert.equal(reconstructed, source);
  }
  assert.throws(() => sliceRedactedText(source, 8, 8), { code: 'UNSAFE_TEXT_OFFSET' });
});
