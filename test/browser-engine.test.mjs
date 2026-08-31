import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBrowserEngine } from '../src/runtime/browser-engine.mjs';

test('browser engine resolver maps fixed engines and preserves persistent extension policy', () => {
  const chromium = {};
  assert.deepEqual(resolveBrowserEngine({ chromium }, {
    kind: 'persistent', browserEngine: 'chrome', headless: false, extensionsEnabled: true
  }), {
    browserType: chromium,
    launchOptions: { channel: 'chrome', ignoreDefaultArgs: ['--disable-extensions'] }
  });
  assert.deepEqual(resolveBrowserEngine({ chromium }, {
    kind: 'persistent', browserEngine: 'chromium', headless: false, extensionsEnabled: true
  }), {
    browserType: chromium,
    launchOptions: { ignoreDefaultArgs: ['--disable-extensions'] }
  });
  assert.deepEqual(resolveBrowserEngine({ chromium }, {
    kind: 'persistent', browserEngine: 'chrome', headless: true, extensionsEnabled: false
  }), {
    browserType: chromium,
    launchOptions: { channel: 'chrome' }
  });
  assert.deepEqual(resolveBrowserEngine({ chromium }, {
    kind: 'ephemeral', browserEngine: 'chromium', headless: false, extensionsEnabled: false
  }), {
    browserType: chromium,
    launchOptions: {}
  });
  assert.throws(
    () => resolveBrowserEngine({ chromium }, {
      kind: 'persistent', browserEngine: 'chrome', headless: true, extensionsEnabled: true
    }),
    { code: 'PROFILE_EXTENSIONS_HEADLESS_CONFLICT' }
  );
  assert.throws(
    () => resolveBrowserEngine({ chromium }, {
      kind: 'ephemeral', browserEngine: 'chromium', headless: false, extensionsEnabled: true
    }),
    { code: 'EPHEMERAL_PROFILE_EXTENSIONS_UNSUPPORTED' }
  );
  assert.throws(
    () => resolveBrowserEngine({ chromium }, { browserEngine: 'chrome-beta' }),
    { code: 'BROWSER_ENGINE_UNSUPPORTED' }
  );
});
