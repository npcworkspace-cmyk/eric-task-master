import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBrowserEngine } from '../src/runtime/browser-engine.mjs';

test('browser engine resolver maps only fixed Chrome and managed Chromium engines', () => {
  const chromium = {};
  assert.deepEqual(resolveBrowserEngine({ chromium }, { browserEngine: 'chrome' }), {
    browserType: chromium,
    launchOptions: { channel: 'chrome' }
  });
  assert.deepEqual(resolveBrowserEngine({ chromium }, { browserEngine: 'chromium' }), {
    browserType: chromium,
    launchOptions: {}
  });
  assert.throws(
    () => resolveBrowserEngine({ chromium }, { browserEngine: 'chrome-beta' }),
    { code: 'BROWSER_ENGINE_UNSUPPORTED' }
  );
});
