import assert from 'node:assert/strict';
import test from 'node:test';
import { chromeLaunchOptions, launchChromeProfile } from '../src/runtime/browser-engine.mjs';

test('stable Chrome enables its sandbox without disabling installed extensions', () => {
  const options = chromeLaunchOptions({ timeout: 60_000 });
  assert.equal(options.channel, 'chrome');
  assert.equal(options.headless, false);
  assert.equal(options.chromiumSandbox, true);
  assert.deepEqual(options.ignoreDefaultArgs, ['--disable-extensions']);
  assert.equal(options.timeout, 60_000);
});

test('persistent Chrome receives sandbox configuration and the original Profile directory', async () => {
  const context = {};
  let received;
  const playwright = { chromium: { launchPersistentContext: async (directory, options) => {
    received = { directory, options };
    return context;
  } } };
  assert.equal(await launchChromeProfile(playwright, { userDataDir: 'test-profile' }), context);
  assert.equal(received.directory, 'test-profile');
  assert.equal(received.options.chromiumSandbox, true);
});

test('sandbox launch failure is surfaced without silently retrying unsandboxed', async () => {
  const cause = new Error('sandbox unavailable');
  const calls = [];
  const playwright = { chromium: { launchPersistentContext: async (_directory, options) => {
    calls.push(options);
    throw cause;
  } } };
  await assert.rejects(launchChromeProfile(playwright, { userDataDir: 'test-profile' }), (error) => {
    assert.equal(error.code, 'CHROME_LAUNCH_FAILED');
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chromiumSandbox, true);
});
