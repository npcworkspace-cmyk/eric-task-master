import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { createNativeChrome, findNativeChrome, nativeChromeCandidates } from '../src/runtime/native-chrome.mjs';

test('native Chrome resolves stable installations on Windows, macOS, and Linux without a bundled browser', async () => {
  assert.deepEqual(nativeChromeCandidates({ platform: 'win32', env: {
    PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\用户\\AppData\\Local'
  } }), [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\用户\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
  ]);
  assert.deepEqual(nativeChromeCandidates({ platform: 'darwin', home: '/Users/test user' }), [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Users/test user/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ]);
  assert.deepEqual(nativeChromeCandidates({ platform: 'linux' }), [
    '/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'
  ]);
  const checked = [];
  assert.equal(await findNativeChrome({ candidates: ['missing', 'stable'], checkAccess: async (file) => {
    checked.push(file); if (file === 'missing') throw new Error('missing');
  } }), 'stable');
  assert.deepEqual(checked, ['missing', 'stable']);
  await assert.rejects(findNativeChrome({ candidates: [] }), { code: 'CHROME_UNAVAILABLE' });
});

function fixture() {
  const directory = path.resolve('isolated profile with spaces');
  const child = new EventEmitter();
  Object.assign(child, { pid: 14521, exitCode: null, signalCode: null });
  let usage = 'inactive';
  let clock = 0;
  let spawned;
  let closes = 0;
  return {
    directory, child,
    get spawned() { return spawned; },
    get closes() { return closes; },
    set usage(value) { usage = value; },
    exit() { child.exitCode = 0; child.emit('exit', 0, null); },
    options: {
      findExecutable: async () => '/stable/chrome',
      spawnProcess: (...args) => { spawned = args; usage = 'active'; return child; },
      probeProfile: async (value) => { assert.equal(value, directory); return usage; },
      requestClose: async () => { closes++; child.exitCode = 0; child.emit('exit', 0, null); usage = 'inactive'; },
      now: () => clock,
      pause: async (ms) => { clock += ms; },
      pollMs: 1
    }
  };
}

test('manual Chrome launches directly with the original directory and no automation arguments', async () => {
  const f = fixture();
  const browser = await createNativeChrome({ userDataDir: f.directory }, f.options);
  await browser.ready();
  assert.deepEqual(f.spawned, ['/stable/chrome', [`--user-data-dir=${f.directory}`, '--no-first-run', '--new-window', 'about:blank'], {
    detached: false, windowsHide: true, stdio: 'ignore', shell: false
  }]);
  assert.doesNotMatch(JSON.stringify(f.spawned), /remote-debugging|enable-automation|no-sandbox|headless/u);
  assert.equal(await browser.close(), true);
  assert.equal(f.closes, 1);
});

test('pre-existing or unobservable Profile usage never spawns another Chrome', async () => {
  for (const usage of ['active', 'unknown']) {
    const f = fixture(); f.usage = usage;
    await assert.rejects(createNativeChrome({ userDataDir: f.directory }, f.options), { code: 'PROFILE_IN_USE' });
    assert.equal(f.spawned, undefined);
  }
});

test('launcher exit cannot release a Profile still owned by Chrome', async () => {
  const f = fixture();
  const browser = await createNativeChrome({ userDataDir: f.directory }, f.options);
  await browser.ready();
  f.exit();
  assert.equal(await browser.close({ timeoutMs: 3 }), false);
  assert.equal(f.closes, 0, 'never signal a stale child PID');
  const controller = new AbortController();
  // A wait may return on cancellation, but must never treat the launcher exit as browser cleanup.
  controller.abort();
  await browser.waitForClose(controller.signal);
  assert.equal(await browser.close({ timeoutMs: 3 }), false);
  f.usage = 'unknown';
  assert.equal(await browser.close({ timeoutMs: 3 }), false);
  f.usage = 'inactive';
  assert.equal(await browser.close({ timeoutMs: 3 }), true);
});

test('manual wait remains live after launcher exit until the exact Profile becomes inactive', async () => {
  const f = fixture();
  let pauses = 0;
  f.options.pause = async () => { if (++pauses === 2) f.usage = 'inactive'; };
  const browser = await createNativeChrome({ userDataDir: f.directory }, f.options);
  await browser.ready();
  f.exit();
  await browser.waitForClose();
  assert.equal(pauses, 2);
});

test('early launcher exit with active Profile fails readiness and does not confirm cleanup', async () => {
  const f = fixture();
  const browser = await createNativeChrome({ userDataDir: f.directory }, f.options);
  f.exit();
  await assert.rejects(browser.ready(), { code: 'CHROME_LAUNCH_FAILED' });
  assert.equal(await browser.close({ timeoutMs: 3 }), false);
});

test('failed close cannot report success just because its request was accepted', async () => {
  const f = fixture();
  f.options.requestClose = async () => {};
  const browser = await createNativeChrome({ userDataDir: f.directory }, f.options);
  await browser.ready();
  assert.equal(await browser.close({ timeoutMs: 3 }), false);
});

test('native launch respects cancellation before starting a browser', async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(createNativeChrome({ userDataDir: f.directory }, { ...f.options, signal: controller.signal }), /cancelled/u);
  assert.equal(f.spawned, undefined);
});
