import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createSystemNotifier } from '../src/lib/system-notifier.mjs';

function spawnRecorder(calls, exitCode = 0) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit('exit', exitCode));
    return child;
  };
}

function spawnSequence(calls, exitCodes) {
  let index = 0;
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.kill = () => {};
    const exitCode = exitCodes[Math.min(index, exitCodes.length - 1)];
    index += 1;
    queueMicrotask(() => child.emit('exit', exitCode));
    return child;
  };
}

test('system notifier uses shell-free bounded platform commands', async () => {
  const windows = [];
  await createSystemNotifier({
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    probe: () => true,
    spawnImpl: spawnRecorder(windows)
  })({ title: 'Title', message: '<private & message>' });
  assert.equal(windows[0].executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(windows[0].options.shell, false);
  assert.equal(windows.length, 2, 'Windows initializes its AppUserModelID before showing a toast');
  assert.ok(windows.every((call) => call.args.includes('-File')));
  assert.ok(windows[1].args.includes('-TargetUrlB64'));
  assert.equal(JSON.stringify(windows).includes('<private & message>'), false);

  const mac = [];
  await createSystemNotifier({ platform: 'darwin', probe: () => true, spawnImpl: spawnRecorder(mac) })({
    title: 'Task Master',
    message: 'Needs attention'
  });
  assert.equal(mac[0].executable, 'osascript');
  assert.equal(mac[0].options.shell, false);

  const linux = [];
  await createSystemNotifier({ platform: 'linux', probe: () => true, spawnImpl: spawnRecorder(linux) })({
    title: 'Task Master',
    message: 'Needs attention'
  });
  assert.equal(linux[0].executable, 'notify-send');
  assert.equal(linux[0].options.shell, false);
});

test('Windows helper owns AUMID registration and protocol activation for the Dashboard task', async () => {
  const helper = await readFile(new URL('../src/lib/windows-notification.ps1', import.meta.url), 'utf8');
  assert.match(helper, /SetCurrentProcessExplicitAppUserModelID/u);
  assert.match(helper, /System\.AppUserModel\.ID|AppUserModelId/u);
  assert.match(helper, /activationType=`"protocol`"/u);
  assert.match(helper, /arguments=`"\$safeActivation`"/u);
  assert.match(helper, /ms-settings:notifications/u);
  assert.ok(
    helper.indexOf("if ($Mode -eq 'setup') { exit 0 }") < helper.indexOf('$notifier = Get-Notifier'),
    'setup must return after registration instead of probing Windows toast state'
  );
});

test('system notifier exposes cached supported and configured capability probes', async () => {
  let probes = 0;
  const unavailable = createSystemNotifier({
    platform: 'linux',
    environment: {},
    probe: () => {
      probes += 1;
      return false;
    },
    spawnImpl: spawnRecorder([])
  });
  assert.equal(unavailable.supported, true);
  assert.equal(unavailable.configured, false);
  assert.equal(probes, 1);
  await assert.rejects(
    unavailable({ title: 'x', message: 'y' }),
    { code: 'SYSTEM_NOTIFICATION_NOT_CONFIGURED' }
  );
  assert.equal(probes, 1);

  const available = createSystemNotifier({
    platform: 'darwin',
    probe: () => true,
    spawnImpl: spawnRecorder([])
  });
  assert.equal(available.supported, true);
  assert.equal(available.configured, true);

  const unsupported = createSystemNotifier({ platform: 'aix', probe: () => true, spawnImpl: spawnRecorder([]) });
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.configured, false);
});

test('Windows notifier exposes setup, permission, test failure, and settings states', async () => {
  const readyCalls = [];
  const ready = createSystemNotifier({
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    probe: () => true,
    spawnImpl: spawnSequence(readyCalls, [0, 0])
  });
  assert.deepEqual(ready.status(), {
    state: 'needs_setup', supported: true, configured: false, canOpenSettings: true
  });
  assert.equal((await ready.initialize()).state, 'ready');
  await ready.openSettings();
  assert.equal(readyCalls.at(-1).args[readyCalls.at(-1).args.indexOf('-Mode') + 1], 'open-settings');

  const blocked = createSystemNotifier({
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    probe: () => true,
    spawnImpl: spawnRecorder([], 21)
  });
  assert.equal((await blocked.initialize()).state, 'permission_blocked');
  assert.equal(blocked.status().configured, true);

  const setupFailed = createSystemNotifier({
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    probe: () => true,
    spawnImpl: spawnRecorder([], 1)
  });
  assert.equal((await setupFailed.initialize()).state, 'needs_setup');
  assert.equal(setupFailed.status().configured, false);

  const showFailed = createSystemNotifier({
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    probe: () => true,
    spawnImpl: spawnSequence([], [0, 1])
  });
  await assert.rejects(showFailed({ title: 'x', message: 'y' }), { code: 'SYSTEM_NOTIFICATION_FAILED' });
  assert.equal(showFailed.status().state, 'test_failed');
});

test('Windows notifier resolves a changing Dashboard URL when each command is created', async () => {
  const calls = [];
  let dashboardUrl = 'http://127.0.0.1:19946/dashboard';
  const notifier = createSystemNotifier({
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    probe: () => true,
    dashboardUrl: () => dashboardUrl,
    spawnImpl: spawnRecorder(calls)
  });
  await notifier.initialize();
  dashboardUrl = 'http://127.0.0.1:24567/dashboard';
  await notifier({ title: 'x', message: 'y' });

  const decodeArgument = (call, name) => {
    const value = call.args[call.args.indexOf(name) + 1];
    return Buffer.from(value, 'base64').toString('utf8');
  };
  assert.equal(decodeArgument(calls[0], '-DashboardUrlB64'), 'http://127.0.0.1:19946/dashboard');
  assert.equal(decodeArgument(calls[1], '-DashboardUrlB64'), 'http://127.0.0.1:24567/dashboard');
  assert.equal(decodeArgument(calls[1], '-TargetUrlB64'), 'http://127.0.0.1:24567/dashboard');
});

test('system notifier rejects unsupported platforms and failed commands without command output', async () => {
  const unsupported = createSystemNotifier({ platform: 'aix', spawnImpl: spawnRecorder([]) });
  await assert.rejects(unsupported({ title: 'x', message: 'y' }), { code: 'SYSTEM_NOTIFICATION_UNSUPPORTED' });

  const failed = createSystemNotifier({ platform: 'linux', probe: () => true, spawnImpl: spawnRecorder([], 1) });
  await assert.rejects(failed({ title: 'x', message: 'secret output' }), { code: 'SYSTEM_NOTIFICATION_FAILED' });
});
