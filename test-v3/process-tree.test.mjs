import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { commandLineUsesProfile, terminatePosixProcessTree, terminateProcessTree } from '../src/lib/process-tree.mjs';

const ROOT_PID = 41001;
const processRow = (pid, ppid, pgid = pid) => ({ pid, ppid, pgid, state: 'S', startedAt: `started-${pid}` });
const ownedTree = () => [processRow(ROOT_PID, 900), processRow(41002, ROOT_PID),
  processRow(41003, 41002), processRow(99000, 900)];

test('macOS ps command lines match an exact Profile path containing spaces', () => {
  const profile = '/Users/eric/Library/Application Support/Eric Task Master/profiles/profile_123';
  assert.equal(commandLineUsesProfile(
    `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-pipe --user-data-dir=${profile} --no-first-run about:blank`,
    profile,
    { caseInsensitive: false }
  ), true);
  assert.equal(commandLineUsesProfile(
    `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir ${profile} --remote-debugging-pipe`,
    profile,
    { caseInsensitive: false }
  ), true);
  assert.equal(commandLineUsesProfile(
    `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome "--user-data-dir=${profile}" --remote-debugging-pipe`,
    profile,
    { caseInsensitive: false }
  ), true);
});

test('Profile command-line matching rejects path prefixes and different Profiles', () => {
  const profile = '/Users/eric/Library/Application Support/Eric Task Master/profiles/profile_123';
  const base = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(commandLineUsesProfile(
    `${base} --user-data-dir=${profile} Copy --remote-debugging-pipe`,
    profile,
    { caseInsensitive: false }
  ), false);
  assert.equal(commandLineUsesProfile(
    `${base} --user-data-dir=${profile}-other --remote-debugging-pipe`,
    profile,
    { caseInsensitive: false }
  ), false);
  assert.equal(commandLineUsesProfile(
    `${base} --user-data-dir=/Users/eric/Library/Application Support/Eric Task Master/profiles/profile_999 --remote-debugging-pipe`,
    profile,
    { caseInsensitive: false }
  ), false);
  assert.equal(commandLineUsesProfile(
    `${base} --description=${profile} --remote-debugging-pipe`,
    profile,
    { caseInsensitive: false }
  ), false);
});

test('Windows Profile command-line matching is case-insensitive and space-safe', () => {
  const profile = 'C:\\Users\\Eric\\Task Master\\profiles\\profile_123';
  assert.equal(commandLineUsesProfile(
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=c:\\users\\eric\\task master\\profiles\\PROFILE_123" --remote-debugging-pipe',
    profile,
    { caseInsensitive: true }
  ), true);
});

test('POSIX forced cleanup includes proven detached descendant groups and leaves unrelated groups alone', async () => {
  let rows = ownedTree();
  const signals = [];
  let reads = 0;
  const terminated = await terminatePosixProcessTree(ROOT_PID, {
    readProcesses: async () => { reads += 1; return rows; }, delay: async () => {},
    signalGroup: (group, signal) => {
      signals.push({ group, signal });
      if (signal === 'SIGTERM') rows = rows.filter((row) => row.pgid !== group);
      return true;
    }
  });
  assert.equal(terminated, true);
  assert.deepEqual(signals.filter(({ signal }) => signal === 'SIGTERM').map(({ group }) => group).sort(),
    [ROOT_PID, 41002, 41003]);
  assert.equal(signals.some(({ group }) => group === 99000), false);
  assert.deepEqual(rows.map(({ pid }) => pid), [99000]);
  assert.equal(reads, 3, 'stable enumeration and one completion snapshot, without repeated polling');
});

for (const failure of ['enumeration', 'throw', 'identity', 'signal']) {
  test(`POSIX ${failure} failure resumes every temporarily frozen group and returns unconfirmed`, async () => {
    const rows = ownedTree();
    const signals = [];
    let reads = 0;
    const terminated = await terminatePosixProcessTree(ROOT_PID, {
      readProcesses: async () => {
        reads += 1;
        if (reads === 1 || failure === 'signal') return rows;
        if (failure === 'enumeration') return null;
        if (failure === 'throw') throw new Error('ps failed');
        return rows.map((row) => row.pid === ROOT_PID ? { ...row, startedAt: 'reused-pid' } : row);
      },
      delay: async () => {},
      signalGroup: (group, signal) => { signals.push({ group, signal }); return signal !== 'SIGTERM'; }
    });
    assert.equal(terminated, false);
    const frozen = signals.filter(({ signal }) => signal === 'SIGSTOP').map(({ group }) => group).sort();
    assert.deepEqual(signals.filter(({ signal }) => signal === 'SIGCONT').map(({ group }) => group).sort(), frozen);
    assert.equal(signals.some(({ signal }) => signal === 'SIGKILL'), false);
  });
}

test('POSIX refuses a group containing an unrelated process before sending any signals', async () => {
  const signals = [];
  const rows = [...ownedTree(), processRow(88000, 900, 41002)];
  assert.equal(await terminatePosixProcessTree(ROOT_PID, {
    readProcesses: async () => rows, signalGroup: (...args) => { signals.push(args); return true; },
    delay: async () => {}
  }), false);
  assert.deepEqual(signals, []);
});

test('POSIX descendant enumeration is bounded and thaws all groups when it cannot stabilize', async () => {
  const rows = ownedTree();
  const signals = [];
  let reads = 0;
  assert.equal(await terminatePosixProcessTree(ROOT_PID, {
    readProcesses: async () => { reads += 1; rows.push(processRow(42000 + reads, ROOT_PID)); return rows; },
    signalGroup: (group, signal) => { signals.push({ group, signal }); return true; }, delay: async () => {}
  }), false);
  assert.equal(reads, 4);
  assert.deepEqual(signals.filter(({ signal }) => signal === 'SIGSTOP').map(({ group }) => group).sort(),
    signals.filter(({ signal }) => signal === 'SIGCONT').map(({ group }) => group).sort());
  assert.equal(signals.some(({ signal }) => signal === 'SIGTERM'), false);
});

test('POSIX escalates only surviving known groups and treats zombies as already terminated', async () => {
  let rows = ownedTree();
  const killed = [];
  assert.equal(await terminatePosixProcessTree(ROOT_PID, {
    readProcesses: async () => rows, delay: async () => {},
    signalGroup: (group, signal) => {
      if (signal === 'SIGKILL') {
        killed.push(group);
        rows = rows.map((row) => row.pgid === group ? { ...row, state: 'Z' } : row);
      }
      return true;
    }
  }), true);
  assert.deepEqual(killed.sort(), [ROOT_PID, 41002, 41003]);
});

test('POSIX cannot claim complete cleanup when the root identity is already missing', async () => {
  let signalled = false;
  assert.equal(await terminatePosixProcessTree(ROOT_PID, {
    readProcesses: async () => [processRow(41002, 1)], delay: async () => {},
    signalGroup: () => { signalled = true; return true; }
  }), false);
  assert.equal(signalled, false);
});

test('real POSIX cleanup terminates a detached child and grandchild in independent groups', {
  skip: !['linux', 'darwin'].includes(process.platform), timeout: 15_000
}, async (t) => {
  const grandchildSource = 'process.send({ pid: process.pid }); setTimeout(() => process.exit(0), 12000);';
  const childSource = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    child.once('message', (message) => process.send({ pid: process.pid, grandchildPid: message.pid }));
    setTimeout(() => process.exit(0), 12000);
  `;
  const rootSource = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    child.once('message', (message) => process.send({ childPid: message.pid, grandchildPid: message.grandchildPid }));
    setTimeout(() => process.exit(0), 12000);
  `;
  const worker = spawn(process.execPath, ['-e', rootSource], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  const ownedPids = [worker.pid];
  const exited = once(worker, 'exit');
  t.after(async () => {
    for (const pid of ownedPids.reverse()) {
      try { process.kill(-pid, 'SIGCONT'); process.kill(-pid, 'SIGKILL'); } catch { /* Already terminated. */ }
    }
    await exited;
  });
  const [ready] = await once(worker, 'message', { signal: AbortSignal.timeout(5_000) });
  ownedPids.push(ready.childPid, ready.grandchildPid);
  const exec = promisify(execFile);
  const before = await exec('ps', ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat=']);
  for (const pid of ownedPids) assert.match(before.stdout, new RegExp(`^\\s*${pid}\\s+${pid}\\s+`, 'mu'));
  assert.equal(await terminateProcessTree(worker.pid, { graceMs: 500 }), true);
  await exited;
  const after = await exec('ps', ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat=']);
  for (const line of after.stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/u.exec(line);
    if (match && ownedPids.includes(Number(match[1]))) assert.match(match[3], /^Z/u, 'no owned process can remain executable');
  }
});
