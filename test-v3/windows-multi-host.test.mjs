import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { removeTestTree } from './test-fs.mjs';
import { isProcessAlive } from '../src/lib/process-tree.mjs';

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const helper = path.join(ROOT, 'test-v3/windows-host-context.ps1');
const cli = path.join(ROOT, 'src/cli.mjs');

async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

test('real Windows legacy union view is preserved by one explicit Owner upgrade and read by an unpackaged client',
  { skip: process.platform !== 'win32', timeout: 180_000 }, async (t) => {
    const root = await mkdtemp(path.join(ROOT, 'artifacts', 'windows-upgrade-'));
    const home = path.join(root, 'home');
    const local = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'taskmaster-upgrade-test-' + randomUUID());
    const legacy = path.join(local, 'eric-task-master');
    const sharedPort = await port();
    const profileId = 'profile_' + 'e'.repeat(32);
    const environment = { USERPROFILE: home, HOME: home, LOCALAPPDATA: local,
      ERIC_TASK_MASTER_HOME: '', ERIC_TASK_MASTER_PORT: String(sharedPort), NODE_OPTIONS: '', NODE_PATH: '',
      OWNER_TEST_LEGACY: legacy, OWNER_TEST_PROFILE: profileId };
    const setup = path.join(root, 'setup.mjs');
    await mkdir(home);
    await writeFile(setup, [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      "const root = process.env.OWNER_TEST_LEGACY; const id = process.env.OWNER_TEST_PROFILE;",
      "await mkdir(root, { recursive: true });",
      "if (process.argv[2] === 'base') {",
      "  await mkdir(path.join(root, 'profiles', id, 'Default', 'Network'), { recursive: true });",
      "  await writeFile(path.join(root, 'profiles', id, 'Local State'), 'lower-view-local-state');",
      "  await writeFile(path.join(root, 'profiles', id, 'Default', 'Network', 'Cookies'), 'lower-view-login-canary');",
      "} else {",
      "  await writeFile(path.join(root, 'config.json'), JSON.stringify({ version: 3, managerToken: 'fixture-owner-token-'.repeat(3), stateInstanceId: 'fixture-owner-instance-0001' }));",
      "  await writeFile(path.join(root, 'profiles.json'), JSON.stringify({ version: 1, defaultProfileId: id, deletions: [], profiles: [{ id, name: 'Legacy lower-layer Profile', userDataDir: path.join(root, 'profiles', id), state: 'idle', lease: null }] }));",
      "}",
      "process.stdout.write(JSON.stringify({ ok: true }));"
    ].join('\n'));
    const call = async (arguments_, breakaway = false, script = cli) => {
      const output = path.join(root, randomUUID() + '.json');
      const payload = Buffer.from(JSON.stringify({ node: process.execPath, cli: script, cwd: ROOT,
        arguments: arguments_, output, environment })).toString('base64');
      await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', helper, '-Payload', payload, ...(breakaway ? ['-Breakaway'] : ['-Packaged'])],
      { windowsHide: true, timeout: 65_000, maxBuffer: 1024 * 1024 });
      return JSON.parse(await readFile(output, 'utf8'));
    };
    const normal = await call(['help']);
    if (!normal.packaged) { await removeTestTree(root); t.skip('requires an actual MSIX Agent host'); return; }
    const overlay = await call(['packaged'], false, setup);
    assert.equal(overlay.exitCode, 0, overlay.stderr);
    const base = await call(['base'], true, setup);
    assert.equal(base.packaged, false);
    assert.equal(base.exitCode, 0, base.stderr);
    const physical = path.dirname(await import('node:fs/promises').then(({ realpath }) => realpath(path.join(legacy, 'config.json'))));
    await assert.rejects(readFile(path.join(physical, 'profiles', profileId, 'Local State')), { code: 'ENOENT' });
    t.after(async () => {
      const stopped = await call(['manager', 'stop', '--if-idle', '--json'], true);
      assert.equal(stopped.exitCode, 0, stopped.stderr);
      await removeTestTree(root);
    });
    const ordinary = await call(['manager', 'start', '--json']);
    assert.equal(ordinary.exitCode, 1);
    assert.equal(JSON.parse(ordinary.stderr.trim().split(/\r?\n/u).at(-1)).error.details.managerCode,
      'MANAGER_STATE_UPGRADE_REQUIRED');
    const upgraded = await call(['manager', 'start', '--upgrade', '--json']);
    assert.equal(upgraded.exitCode, 0, upgraded.stderr);
    const manager = JSON.parse(upgraded.stdout.trim().split(/\r?\n/u).at(-1)).manager;
    assert.equal(manager.stateDirEffective, path.join(home, '.eric-task-master', 'state'));
    const native = await call(['profiles', 'list', '--json'], true);
    assert.equal(native.exitCode, 0, native.stderr);
    assert.deepEqual(JSON.parse(native.stdout).profiles.map((profile) => [profile.id, profile.name, profile.isDefault]),
      [[profileId, 'Legacy lower-layer Profile', true]]);
    assert.equal(await readFile(path.join(manager.stateDirEffective, 'profiles', profileId, 'Default', 'Network', 'Cookies'), 'utf8'),
      'lower-view-login-canary');
    assert.equal(await readFile(path.join(legacy, 'profiles', profileId, 'Local State'), 'utf8'), 'lower-view-local-state');
    const reused = await call(['manager', 'start', '--upgrade', '--json'], true);
    assert.equal(reused.exitCode, 0, reused.stderr);
    assert.equal(JSON.parse(reused.stdout).manager.pid, manager.pid);
    t.diagnostic(JSON.stringify({ realMsixUnionView: true, originalSourceRetained: true,
      ownerUpgradePreservesLowerLayer: true, unpackagedProfilesVisible: true, repeatedUpgradeReusesPid: true }));
  });

test('real packaged and unpackaged Windows clients share defaults and each explicit AppData project',
  { skip: process.platform !== 'win32', timeout: 180_000 }, async (t) => {
    // The homes are outside AppData. The explicit project is inside actual
    // AppData so Windows, not a fake resolver, supplies the differing views.
    const root = await mkdtemp(path.join(ROOT, 'artifacts', 'windows-host-'));
    const home = path.join(root, 'home');
    await mkdir(home);
    const local = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'taskmaster-host-test-' + randomUUID());
    const sharedPort = await port();
    const environment = { USERPROFILE: home, HOME: home, LOCALAPPDATA: local, ERIC_TASK_MASTER_HOME: '',
      ERIC_TASK_MASTER_PORT: String(sharedPort), NODE_OPTIONS: '', NODE_PATH: '' };
    const project = path.join(local, 'explicit-project');
    const call = async (arguments_, breakaway = false, projectMode = false) => {
      const output = path.join(root, randomUUID() + '.json');
      const payload = Buffer.from(JSON.stringify({ node: process.execPath, cli, cwd: ROOT,
        arguments: [...arguments_, '--json'], output,
        environment: { ...environment, ...(projectMode ? { ERIC_TASK_MASTER_PORT: null } : {}) }
      })).toString('base64');
      await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', helper, '-Payload', payload, ...(breakaway ? ['-Breakaway'] : ['-Packaged'])],
      { windowsHide: true, timeout: 65_000, maxBuffer: 1024 * 1024 });
      const value = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(value.exitCode, 0, value.stderr);
      return { ...value, value: arguments_[0] === 'help' ? value.stdout : JSON.parse(value.stdout.trim().split(/\r?\n/u).at(-1)) };
    };
    const normal = await call(['help']);
    const unpackaged = await call(['help'], true);
    assert.equal(unpackaged.packaged, false, 'the second client must genuinely lack MSIX package identity');
    if (!normal.packaged) {
      await removeTestTree(root);
      t.skip('this Windows host has no packaged parent; run this acceptance from an MSIX Agent host');
      return;
    }
    const active = [];
    const managersByScope = new Map();
    t.after(async () => {
      for (const target of active) {
        const manager = managersByScope.get(target.length ? 'project' : 'shared');
        let settled = false;
        const observed = [];
        const probe = (async () => {
          while (!settled && manager) {
            const alive = isProcessAlive(manager.pid);
            let state;
            try { state = (await (await fetch(manager.baseUrl + '/v1/health', { signal: AbortSignal.timeout(500) })).json()).state; }
            catch { state = 'unreachable'; }
            observed.push({ alive, state });
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        })();
        try { await call(['manager', 'stop', ...target], true, target.length > 0); }
        catch (error) { t.diagnostic(JSON.stringify({ cleanupScope: target.length ? 'project' : 'shared', observed })); throw error; }
        finally { settled = true; await probe; }
      }
      await removeTestTree(root);
      // Keep the physical AppData fixture when it differs from the lexical
      // path: test cleanup must never guess which host owns a redirected tree.
    });
    active.push([]);
    const defaults = await Promise.all([call(['manager', 'start']), call(['manager', 'start'], true)]);
    assert.equal(defaults[0].value.manager.pid, defaults[1].value.manager.pid);
    assert.equal(defaults[0].value.manager.stateDirectoryId, defaults[1].value.manager.stateDirectoryId);
    const profile = await call(['profiles', 'create', 'Cross host shared Profile']);
    const list = await call(['profiles', 'list'], true);
    assert.deepEqual(list.value.profiles.map((item) => item.id), [profile.value.profile.id]);
    const sharedPid = defaults[0].value.manager.pid;
    await call(['manager', 'stop', '--if-idle'], true);
    const restarted = await call(['manager', 'start'], true);
    managersByScope.set('shared', { pid: restarted.value.manager.pid, baseUrl: 'http://127.0.0.1:' + sharedPort });
    assert.notEqual(restarted.value.manager.pid, sharedPid);
    assert.deepEqual((await call(['profiles', 'list'])).value.profiles.map((item) => item.id), [profile.value.profile.id]);

    const target = ['--state-dir', project];
    active.push(target);
    const projects = await Promise.all([call(['manager', 'start', ...target], false, true),
      call(['manager', 'start', ...target], true, true)]);
    assert.equal(projects[0].value.manager.pid, projects[1].value.manager.pid);
    assert.notEqual(projects[0].value.manager.pid, restarted.value.manager.pid);
    assert.equal(projects[0].value.manager.stateDirectoryId, projects[1].value.manager.stateDirectoryId);
    assert.equal(projects[0].value.manager.scope, 'project');
    const projectEndpoint = JSON.parse(await readFile(path.join(projects[0].value.manager.stateDirEffective, 'manager.json'), 'utf8'));
    managersByScope.set('project', { pid: projects[0].value.manager.pid, baseUrl: projectEndpoint.baseUrl });
    const projectProfile = await call(['profiles', 'create', 'Independent project Profile', ...target], true, true);
    assert.deepEqual((await call(['profiles', 'list', ...target], false, true)).value.profiles.map((item) => item.id),
      [projectProfile.value.profile.id]);
    assert.deepEqual((await call(['profiles', 'list'])).value.profiles.map((item) => item.id), [profile.value.profile.id]);
    const effective = projects[0].value.manager.stateDirEffective;
    assert.ok(path.isAbsolute(effective));
    t.diagnostic(JSON.stringify({ packagedClient: true, unpackagedClient: true,
      sharedReuse: true, sharedProfilesSurviveRestart: true, explicitAppDataProjectReuse: true,
      sharedAndProjectIsolated: true, physicalProject: effective }));
  });
