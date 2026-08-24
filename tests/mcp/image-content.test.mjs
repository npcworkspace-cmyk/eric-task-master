import assert from 'node:assert/strict';
import test from 'node:test';
import { completeImageContent } from '../../src/mcp/server.mjs';

function imageChunk(overrides = {}) {
  return {
    artifact: { id: 'artifact_image', mimeType: 'image/png' },
    offset: 0,
    eof: true,
    encoding: 'base64',
    chunk: 'iVBORw0KGgo=',
    ...overrides
  };
}

test('complete base64 image artifact becomes MCP image content', () => {
  assert.deepEqual(completeImageContent(imageChunk()), {
    type: 'image',
    data: 'iVBORw0KGgo=',
    mimeType: 'image/png'
  });
});

test('partial image artifact chunks never become MCP image content', () => {
  assert.equal(completeImageContent(imageChunk({ eof: false })), null);
  assert.equal(completeImageContent(imageChunk({ offset: 48 * 1024 })), null);
});
