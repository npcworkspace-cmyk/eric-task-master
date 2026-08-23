import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapNextAction, playwrightInstallArguments } from '../scripts/bootstrap-policy.mjs';

test('Linux first connect installs Chromium with its native dependencies', () => {
  assert.deepEqual(playwrightInstallArguments('/project/playwright/cli.js', 'linux'), [
    '/project/playwright/cli.js',
    'install',
    '--with-deps',
    'chromium'
  ]);
  assert.match(
    bootstrapNextAction({ code: 'BROWSER_INSTALL_FAILED' }, 'linux'),
    /Linux system packages/
  );
});

test('Windows and macOS keep the ordinary Playwright Chromium install', () => {
  for (const platform of ['win32', 'darwin']) {
    assert.deepEqual(playwrightInstallArguments('playwright-cli', platform), [
      'playwright-cli',
      'install',
      'chromium'
    ]);
  }
});
