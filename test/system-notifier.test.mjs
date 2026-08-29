import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  assert.ok(windows[0].args.includes('-Command'));
  assert.equal(JSON.stringify(windows[0]).includes('<private & message>'), false);

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

test('system notifier rejects unsupported platforms and failed commands without command output', async () => {
  const unsupported = createSystemNotifier({ platform: 'aix', spawnImpl: spawnRecorder([]) });
  await assert.rejects(unsupported({ title: 'x', message: 'y' }), { code: 'SYSTEM_NOTIFICATION_UNSUPPORTED' });

  const failed = createSystemNotifier({ platform: 'linux', probe: () => true, spawnImpl: spawnRecorder([], 1) });
  await assert.rejects(failed({ title: 'x', message: 'secret output' }), { code: 'SYSTEM_NOTIFICATION_FAILED' });
});
