import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';
import {
  atomicWrite,
  atomicWriteCas,
  readOptionalFile,
  removeFileCas
} from '../../src/registration/files.mjs';
import { createRegistrar } from '../../src/registration/index.mjs';
import { RegistrationLock } from '../../src/registration/lock.mjs';

async function write(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

async function fixture(platform = 'win32') {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-registration-'));
  const home = join(root, '用户 Home');
  const projectRoot = join(root, 'Project With 空格');
  const stateDir = join(root, 'registration state');
  const appData = join(home, 'Roaming Data');
  const localAppData = join(home, 'Local Data');
  const codexHome = join(home, 'Codex 自定义');
  const claudeConfigDir = join(home, 'Claude Code 自定义');
  const hermesHome = join(home, 'Hermes 自定义');
  const workBuddyConfig = join(home, 'WorkBuddy 自定义', '.mcp.json');
  const env = {
    HOME: home,
    USERPROFILE: home,
    PATH: '',
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    HERMES_HOME: hermesHome,
    WORKBUDDY_MCP_CONFIG: workBuddyConfig
  };
  const entrypoint = join(projectRoot, 'src', 'mcp', 'stdio.mjs');
  await write(entrypoint, '// isolated test entrypoint\n');

  const paths = {
    codex: join(codexHome, 'config.toml'),
    'claude-desktop': platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : platform === 'win32'
        ? join(appData, 'Claude', 'claude_desktop_config.json')
        : join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    'claude-code': join(claudeConfigDir, '.claude.json'),
    workbuddy: workBuddyConfig,
    hermes: join(hermesHome, 'config.yaml')
  };
  env.TASKMASTER_CLAUDE_DESKTOP_CONFIG = paths['claude-desktop'];

  await write(paths.codex, [
    'model = "gpt-test"',
    '',
    '[mcp_servers.existing]',
    'command = "existing-command"',
    ''
  ].join('\n'));
  await write(paths['claude-desktop'], `${JSON.stringify({
    theme: 'dark',
    mcpServers: { existing: { command: 'existing-command', args: [] } }
  }, null, 2)}\n`);
  await write(paths['claude-code'], `${JSON.stringify({
    oauthAccount: { displayName: 'preserve me' },
    mcpServers: { existing: { type: 'stdio', command: 'existing-command', args: [] } }
  }, null, 2)}\n`);
  await write(paths.workbuddy, `${JSON.stringify({
    mcpServers: { existing: { command: 'existing-command' } },
    preferences: { language: 'zh-CN' }
  }, null, 2)}\n`);
  await write(paths.hermes, [
    'model: test-model',
    'mcp_servers:',
    '  existing:',
    '    command: "existing-command"',
    '    args: []',
    'theme: dark',
    ''
  ].join('\n'));

  const registrar = createRegistrar({
    env,
    platform,
    home,
    projectRoot,
    stateDir,
    entrypoint,
    executablePath: process.execPath
  });
  return { root, home, projectRoot, stateDir, env, entrypoint, paths, registrar };
}

async function snapshot(paths) {
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, 'utf8')])));
}

function runNode(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: resolve(import.meta.dirname, '..', '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectRun);
    child.once('exit', (code) => resolveRun({ code, stdout, stderr }));
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

test('dry-run plans all detected native hosts without writing state or configs', async () => {
  const setup = await fixture();
  const before = await snapshot(setup.paths);
  const result = await setup.registrar.install({ dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.results.filter((item) => item.status === 'would_register').length, 4);
  assert.deepEqual(await snapshot(setup.paths), before);
  await assert.rejects(readFile(setup.registrar.statePath, 'utf8'), { code: 'ENOENT' });
  for (const item of result.results) {
    if (item.configPath) assert.ok(item.configPath.startsWith(setup.root));
  }
});

test('standalone CLI runs a machine-readable dry-run entirely inside fake HOME', async () => {
  const setup = await fixture();
  const before = await snapshot(setup.paths);
  const run = await runNode([
    'scripts/register-mcp.mjs',
    'install',
    '--dry-run',
    '--json',
    '--home', setup.home,
    '--state-dir', setup.stateDir
  ], { ...process.env, ...setup.env });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.results.filter((item) => item.status === 'would_register').length, 4);
  assert.deepEqual(await snapshot(setup.paths), before);
  await assert.rejects(readFile(setup.registrar.statePath, 'utf8'), { code: 'ENOENT' });
});

test('install merges four verified host configs, skips WorkBuddy, and is idempotent', async () => {
  const setup = await fixture();
  const first = await setup.registrar.install();
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.results.filter((item) => item.status === 'registered_pending_restart').length, 4);
  assert.match(first.installationId, /^[0-9a-f-]{36}$/);

  const codex = await readFile(setup.paths.codex, 'utf8');
  assert.match(codex, /\[mcp_servers\.existing\]/);
  assert.match(codex, /\[mcp_servers\.eric-task-master\]/);
  const desktop = JSON.parse(await readFile(setup.paths['claude-desktop'], 'utf8'));
  const claudeCode = JSON.parse(await readFile(setup.paths['claude-code'], 'utf8'));
  const workbuddy = JSON.parse(await readFile(setup.paths.workbuddy, 'utf8'));
  assert.equal(desktop.theme, 'dark');
  assert.equal(claudeCode.oauthAccount.displayName, 'preserve me');
  assert.equal(workbuddy.preferences.language, 'zh-CN');
  assert.equal(workbuddy.mcpServers['eric-task-master'], undefined);

  const clientIds = new Set();
  for (const [hostKey, document] of [
    ['claude-desktop', desktop],
    ['claude-code', claudeCode]
  ]) {
    const entry = document.mcpServers['eric-task-master'];
    assert.equal(entry.command, process.execPath);
    assert.deepEqual(entry.args, [setup.entrypoint]);
    assert.equal(entry.env.TASKMASTER_CLIENT_ID, `${first.installationId}:${hostKey}`);
    assert.match(entry.env.TASKMASTER_CLIENT_NAME, /^Eric Task Master \/ /);
    assert.equal(JSON.stringify(entry).toLowerCase().includes('token'), false);
    clientIds.add(entry.env.TASKMASTER_CLIENT_ID);
  }
  const hermes = await readFile(setup.paths.hermes, 'utf8');
  assert.match(hermes, /model: test-model/);
  assert.match(hermes, /theme: dark/);
  assert.match(hermes, new RegExp(`${first.installationId}:hermes`));
  assert.equal(clientIds.size, 2);

  const afterFirst = await snapshot(setup.paths);
  const second = await setup.registrar.install();
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.results.filter((item) => item.status === 'registered').length, 4);
  assert.deepEqual(await snapshot(setup.paths), afterFirst);

  const status = await setup.registrar.status();
  assert.equal(status.ok, true);
  assert.equal(status.results.filter((item) => item.status === 'registered').length, 4);
  const state = JSON.parse(await readFile(setup.registrar.statePath, 'utf8'));
  assert.equal(state.installationId, first.installationId);
  assert.equal(Object.keys(state.registrations).length, 4);
  assert.ok(state.transactions[0].actions.every((action) => isAbsolute(action.backupPath)));
});

test('uninstall preserves unrelated later edits and rollback restores the owned entries', async () => {
  const setup = await fixture();
  await setup.registrar.install();
  const desktop = JSON.parse(await readFile(setup.paths['claude-desktop'], 'utf8'));
  desktop.afterInstall = { preserve: true };
  await write(setup.paths['claude-desktop'], `${JSON.stringify(desktop, null, 2)}\n`);

  const removed = await setup.registrar.uninstall();
  assert.equal(removed.ok, true);
  assert.equal(removed.results.filter((item) => item.status === 'unregistered_pending_restart').length, 4);
  const afterRemoval = JSON.parse(await readFile(setup.paths['claude-desktop'], 'utf8'));
  assert.deepEqual(afterRemoval.afterInstall, { preserve: true });
  assert.equal(afterRemoval.mcpServers['eric-task-master'], undefined);
  assert.ok(afterRemoval.mcpServers.existing);

  const rolledBack = await setup.registrar.rollback({ transactionId: removed.transactionId });
  assert.equal(rolledBack.ok, true);
  const restored = JSON.parse(await readFile(setup.paths['claude-desktop'], 'utf8'));
  assert.deepEqual(restored.afterInstall, { preserve: true });
  assert.ok(restored.mcpServers['eric-task-master']);
  const status = await setup.registrar.status();
  assert.equal(status.results.filter((item) => item.status === 'registered').length, 4);
});

test('foreign same-name entry aborts the whole multi-host install without partial writes', async () => {
  const setup = await fixture();
  const desktop = JSON.parse(await readFile(setup.paths['claude-desktop'], 'utf8'));
  desktop.mcpServers['eric-task-master'] = { command: 'foreign-command', args: [] };
  await write(setup.paths['claude-desktop'], `${JSON.stringify(desktop, null, 2)}\n`);
  const before = await snapshot(setup.paths);

  const result = await setup.registrar.install({ hostKeys: ['codex', 'claude-desktop'] });
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(result.results.find((item) => item.hostKey === 'claude-desktop').status, 'conflict');
  assert.deepEqual(await snapshot(setup.paths), before);
  await assert.rejects(readFile(setup.registrar.statePath, 'utf8'), { code: 'ENOENT' });
});

test('invalid config fails closed and does not mutate another planned host', async () => {
  const setup = await fixture();
  await write(setup.paths['claude-code'], '{"serviceCredential":LEAK42}\n');
  const before = await snapshot(setup.paths);
  const result = await setup.registrar.install({ hostKeys: ['codex', 'claude-code'] });
  assert.equal(result.ok, false);
  assert.equal(result.results.find((item) => item.hostKey === 'claude-code').error.code, 'INVALID_HOST_CONFIG');
  assert.equal(JSON.stringify(result).includes('LEAK42'), false);
  assert.deepEqual(await snapshot(setup.paths), before);
});

test('a write failure after the first host restores every changed config from backup', async () => {
  const setup = await fixture();
  const before = await snapshot(setup.paths);
  let injected = false;
  const registrar = createRegistrar({
    env: setup.env,
    platform: 'win32',
    home: setup.home,
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    entrypoint: setup.entrypoint,
    executablePath: process.execPath,
    async writeHostFile(path, bytes, options) {
      if (!injected && path === setup.paths['claude-desktop']) {
        injected = true;
        throw Object.assign(new Error('injected write failure'), { code: 'INJECTED_WRITE_FAILURE' });
      }
      return atomicWrite(path, bytes, options);
    }
  });
  const result = await registrar.install({ hostKeys: ['codex', 'claude-desktop'] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INJECTED_WRITE_FAILURE');
  assert.equal(result.rollback.ok, true);
  assert.deepEqual(await snapshot(setup.paths), before);
  const state = JSON.parse(await readFile(registrar.statePath, 'utf8'));
  assert.deepEqual(state.registrations, {});
  assert.equal(state.transactions.at(-1).status, 'rolled_back_after_failure');
});

test('owned entry can be upgraded in place while installation identity remains stable', async () => {
  const setup = await fixture();
  const first = await setup.registrar.install({ hostKeys: ['codex'] });
  const upgradedEntrypoint = join(setup.projectRoot, 'dist', 'mcp', 'stdio.mjs');
  await write(upgradedEntrypoint, '// upgraded isolated entrypoint\n');
  const upgraded = createRegistrar({
    env: setup.env,
    platform: 'win32',
    home: setup.home,
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    entrypoint: upgradedEntrypoint,
    executablePath: process.execPath
  });
  const beforeStatus = await upgraded.status({ hostKeys: ['codex'] });
  assert.equal(beforeStatus.results[0].status, 'update_available');
  const update = await upgraded.install({ hostKeys: ['codex'] });
  assert.equal(update.ok, true);
  assert.equal(update.installationId, first.installationId);
  assert.ok((await readFile(setup.paths.codex, 'utf8')).includes(JSON.stringify(upgradedEntrypoint)));
});

test('manual changes inside an owned entry are conflicts, not silently overwritten', async () => {
  const setup = await fixture();
  await setup.registrar.install({ hostKeys: ['claude-desktop'] });
  const document = JSON.parse(await readFile(setup.paths['claude-desktop'], 'utf8'));
  document.mcpServers['eric-task-master'].command = 'user-changed-command';
  await write(setup.paths['claude-desktop'], `${JSON.stringify(document, null, 2)}\n`);
  const changedSource = await readFile(setup.paths['claude-desktop'], 'utf8');

  const status = await setup.registrar.status({ hostKeys: ['claude-desktop'] });
  assert.equal(status.results[0].status, 'conflict');
  const install = await setup.registrar.install({ hostKeys: ['claude-desktop'] });
  assert.equal(install.ok, false);
  assert.equal(install.results[0].error.code, 'OWNED_ENTRY_CHANGED');
  const uninstall = await setup.registrar.uninstall({ hostKeys: ['claude-desktop'] });
  assert.equal(uninstall.ok, false);
  assert.equal(uninstall.results[0].error.code, 'OWNED_ENTRY_CHANGED');
  assert.equal(await readFile(setup.paths['claude-desktop'], 'utf8'), changedSource);
});

test('WorkBuddy, DSH, Pi, and OpenClaw are detected but never modified without verified adapters', async () => {
  const setup = await fixture('linux');
  const markerPaths = [join(setup.home, '.dsh', 'marker'), join(setup.home, '.pi', 'marker'), join(setup.home, '.openclaw', 'marker')];
  for (const marker of markerPaths) await write(marker, 'keep\n');
  const before = await Promise.all(markerPaths.map((path) => readFile(path, 'utf8')));
  const workBuddyBefore = await readFile(setup.paths.workbuddy, 'utf8');
  const result = await setup.registrar.install({ hostKeys: ['workbuddy', 'dsh', 'pi', 'openclaw'] });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.results.map((item) => item.status), ['needs_adapter', 'needs_adapter', 'needs_adapter', 'needs_adapter']);
  assert.equal(await readFile(setup.paths.workbuddy, 'utf8'), workBuddyBefore);
  assert.deepEqual(await Promise.all(markerPaths.map((path) => readFile(path, 'utf8'))), before);
  await assert.rejects(readFile(setup.registrar.statePath, 'utf8'), { code: 'ENOENT' });
});

test('host definitions compute expected paths for simulated win32, darwin, and linux inputs', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const setup = await fixture(platform);
    const hosts = Object.fromEntries(setup.registrar.hosts.map((host) => [host.key, host]));
    assert.equal(hosts.codex.configPath, resolve(setup.env.CODEX_HOME, 'config.toml'));
    assert.equal(hosts['claude-code'].configPath, resolve(setup.env.CLAUDE_CONFIG_DIR, '.claude.json'));
    assert.equal(hosts.workbuddy.configPath, resolve(setup.env.WORKBUDDY_MCP_CONFIG));
    assert.equal(hosts.hermes.configPath, resolve(setup.env.HERMES_HOME, 'config.yaml'));
    assert.ok(hosts['claude-desktop'].configPath.startsWith(setup.home));
  }
});

test('rollback refuses to overwrite a host config changed after the transaction', async () => {
  const setup = await fixture();
  const installed = await setup.registrar.install({ hostKeys: ['claude-desktop'] });
  const document = JSON.parse(await readFile(setup.paths['claude-desktop'], 'utf8'));
  document.userEdit = true;
  await write(setup.paths['claude-desktop'], `${JSON.stringify(document, null, 2)}\n`);
  const rollback = await setup.registrar.rollback({ transactionId: installed.transactionId });
  assert.equal(rollback.ok, false);
  assert.equal(rollback.conflicts[0].code, 'ROLLBACK_CONFLICT');
  const preserved = JSON.parse(await readFile(setup.paths['claude-desktop'], 'utf8'));
  assert.equal(preserved.userEdit, true);
  assert.ok(preserved.mcpServers['eric-task-master']);
});

test('rollback dry-run reports a conflict without mutating the transaction journal', async () => {
  const setup = await fixture();
  const installed = await setup.registrar.install({ hostKeys: ['claude-desktop'] });
  const document = JSON.parse(await readFile(setup.paths['claude-desktop'], 'utf8'));
  document.userEdit = 'keep';
  await write(setup.paths['claude-desktop'], `${JSON.stringify(document, null, 2)}\n`);
  const stateBefore = await readFile(setup.registrar.statePath, 'utf8');

  const rollback = await setup.registrar.rollback({
    transactionId: installed.transactionId,
    dryRun: true
  });

  assert.equal(rollback.ok, false);
  assert.equal(rollback.conflicts[0].code, 'ROLLBACK_CONFLICT');
  assert.equal(await readFile(setup.registrar.statePath, 'utf8'), stateBefore);
  assert.equal(JSON.parse(await readFile(setup.paths['claude-desktop'], 'utf8')).userEdit, 'keep');
});

test('cross-process registration lock serializes the full transaction and preserves both owners', async () => {
  const setup = await fixture();
  const repositoryRoot = resolve(import.meta.dirname, '..', '..');
  const repositoryEntrypoint = join(repositoryRoot, 'src', 'mcp', 'stdio.mjs');
  let releaseWriter;
  let writerEntered;
  const entered = new Promise((resolveEntered) => { writerEntered = resolveEntered; });
  const gate = new Promise((resolveGate) => { releaseWriter = resolveGate; });
  const firstRegistrar = createRegistrar({
    env: setup.env,
    platform: 'win32',
    home: setup.home,
    projectRoot: repositoryRoot,
    stateDir: setup.stateDir,
    entrypoint: repositoryEntrypoint,
    executablePath: process.execPath,
    async writeHostFile(filePath, bytes, options) {
      writerEntered();
      await gate;
      return atomicWriteCas(filePath, bytes, options);
    }
  });

  const firstPromise = firstRegistrar.install({ hostKeys: ['codex'] });
  await entered;
  const secondPromise = runNode([
    'scripts/register-mcp.mjs',
    'install',
    '--hosts', 'claude-desktop',
    '--json',
    '--home', setup.home,
    '--state-dir', setup.stateDir
  ], { ...process.env, ...setup.env });
  const exitedWhileLocked = await Promise.race([
    secondPromise.then(() => true),
    delay(200).then(() => false)
  ]);
  assert.equal(exitedWhileLocked, false);
  const beforeRelease = JSON.parse(await readFile(setup.paths['claude-desktop'], 'utf8'));
  assert.equal(beforeRelease.mcpServers['eric-task-master'], undefined);

  releaseWriter();
  const [first, secondRun] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.ok, true);
  assert.equal(secondRun.code, 0, secondRun.stderr || secondRun.stdout);
  const second = JSON.parse(secondRun.stdout);
  assert.equal(second.ok, true);
  assert.equal(second.installationId, first.installationId);
  const state = JSON.parse(await readFile(firstRegistrar.statePath, 'utf8'));
  assert.deepEqual(Object.keys(state.registrations).sort(), ['claude-desktop', 'codex']);
  assert.equal(state.transactions.length, 2);
});

test('two processes recovering the same stale lock never overlap their critical sections', async () => {
  const setup = await fixture();
  await mkdir(setup.stateDir, { recursive: true });
  const lockPath = join(setup.stateDir, '.registration.lock');
  const logPath = join(setup.root, 'critical-sections.jsonl');
  await writeFile(lockPath, `${JSON.stringify({
    pid: 2_147_483_647,
    nonce: 'dead-owner',
    createdAt: new Date(0).toISOString()
  })}\n`, 'utf8');
  const worker = resolve(import.meta.dirname, 'lock-worker.mjs');

  const runs = await Promise.all([
    runNode([worker, lockPath, logPath, '175'], process.env),
    runNode([worker, lockPath, logPath, '175'], process.env)
  ]);
  for (const run of runs) assert.equal(run.code, 0, run.stderr || run.stdout);

  const events = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const intervals = [...new Set(events.map((event) => event.pid))].map((pid) => ({
    enter: events.find((event) => event.pid === pid && event.event === 'enter').at,
    exit: events.find((event) => event.pid === pid && event.event === 'exit').at
  }));
  assert.equal(intervals.length, 2);
  assert.ok(
    intervals[0].exit <= intervals[1].enter || intervals[1].exit <= intervals[0].enter,
    `critical sections overlapped: ${JSON.stringify(intervals)}`
  );
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
  await assert.rejects(lstat(`${lockPath}.recovery`), { code: 'ENOENT' });
});

test('an abandoned stale-lock recovery guard fails closed with an actionable code', async () => {
  const setup = await fixture();
  await mkdir(setup.stateDir, { recursive: true });
  const lockPath = join(setup.stateDir, '.registration.lock');
  await writeFile(`${lockPath}.recovery`, `${JSON.stringify({
    pid: 2_147_483_647,
    nonce: 'abandoned-recovery',
    createdAt: new Date(0).toISOString()
  })}\n`, 'utf8');
  const lock = new RegistrationLock(lockPath, { timeoutMs: 250 });

  await assert.rejects(lock.acquire(), { code: 'REGISTRATION_RECOVERY_GUARD_STALE' });
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
});

test('a completed operation reports lock release failure instead of returning false success', async () => {
  const setup = await fixture();
  let failRelease = true;
  const registrar = createRegistrar({
    env: setup.env,
    platform: 'win32',
    home: setup.home,
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    entrypoint: setup.entrypoint,
    executablePath: process.execPath,
    registrationLockFactory(lockPath, options) {
      return new RegistrationLock(lockPath, {
        ...options,
        async removeFile(target) {
          if (target === lockPath && failRelease) {
            failRelease = false;
            throw Object.assign(new Error('injected release failure'), { code: 'INJECTED_RELEASE_FAILURE' });
          }
          await rm(target, { force: true });
        }
      });
    }
  });

  await assert.rejects(
    registrar.install({ hostKeys: ['codex'] }),
    (error) => error.code === 'REGISTRATION_LOCK_RELEASE_FAILED'
      && error.operationResult?.ok === true
      && error.operationResult?.changed === true
  );
  const state = JSON.parse(await readFile(registrar.statePath, 'utf8'));
  assert.equal(state.transactions.at(-1).status, 'complete');
  assert.match(await readFile(setup.paths.codex, 'utf8'), /mcp_servers\.eric-task-master/);
  await rm(join(setup.stateDir, '.registration.lock'), { force: true });
});

test('host write CAS preserves an edit made after preflight and exits the whole transaction', async () => {
  const setup = await fixture();
  let injected = false;
  const registrar = createRegistrar({
    env: setup.env,
    platform: 'win32',
    home: setup.home,
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    entrypoint: setup.entrypoint,
    executablePath: process.execPath,
    async writeHostFile(filePath, bytes, options) {
      if (!injected) {
        injected = true;
        const source = await readFile(filePath, 'utf8');
        await writeFile(filePath, `${source.trimEnd()}\n# MUST_SURVIVE\n`, 'utf8');
      }
      return atomicWriteCas(filePath, bytes, options);
    }
  });
  const result = await registrar.install({ hostKeys: ['codex'] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFIG_CAS_MISMATCH');
  assert.equal(result.changed, false);
  assert.equal(result.rollback.ok, true);
  assert.equal(result.results[0].status, 'not_applied_external_change');
  const current = await readFile(setup.paths.codex, 'utf8');
  assert.match(current, /MUST_SURVIVE/);
  assert.doesNotMatch(current, /mcp_servers\.eric-task-master/);
});

test('post-assert CAS write preserves an external edit and restores its pathname', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-post-assert-write-'));
  const filePath = join(root, 'config.toml');
  await writeFile(filePath, 'before\n', 'utf8');
  const expected = await readOptionalFile(filePath);

  await assert.rejects(
    atomicWriteCas(filePath, 'taskmaster\n', {
      expected,
      beforeCommit: () => writeFile(filePath, 'external-after-assert\n', 'utf8')
    }),
    { code: 'CONFIG_CAS_MISMATCH' }
  );
  assert.equal(await readFile(filePath, 'utf8'), 'external-after-assert\n');
  assert.equal((await readdir(root)).some((name) => name.includes('eric-task-master-cas')), false);
});

test('post-assert CAS removal preserves an external edit and never reports deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-post-assert-remove-'));
  const filePath = join(root, 'config.yaml');
  await writeFile(filePath, 'before\n', 'utf8');
  const expected = await readOptionalFile(filePath);

  await assert.rejects(
    removeFileCas(filePath, expected, {
      beforeCommit: () => writeFile(filePath, 'external-after-assert\n', 'utf8')
    }),
    { code: 'CONFIG_CAS_MISMATCH' }
  );
  assert.equal(await readFile(filePath, 'utf8'), 'external-after-assert\n');
  assert.equal((await readdir(root)).some((name) => name.includes('eric-task-master-cas')), false);
});

test('no-replace CAS creation preserves a file created after the absence check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-post-assert-create-'));
  const filePath = join(root, 'config.json');
  const expected = await readOptionalFile(filePath);

  await assert.rejects(
    atomicWriteCas(filePath, 'taskmaster\n', {
      expected,
      beforeCommit: () => writeFile(filePath, 'external-created\n', 'utf8')
    }),
    { code: 'CONFIG_CAS_MISMATCH' }
  );
  assert.equal(await readFile(filePath, 'utf8'), 'external-created\n');
});

test('successful CAS publication removes its hidden staging hardlink', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-cas-staging-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, 'config.json');

  const absent = await readOptionalFile(filePath);
  await atomicWriteCas(filePath, 'created\n', { expected: absent });
  assert.equal(await readFile(filePath, 'utf8'), 'created\n');
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);

  const existing = await readOptionalFile(filePath);
  await atomicWriteCas(filePath, 'updated\n', { expected: existing });
  assert.equal(await readFile(filePath, 'utf8'), 'updated\n');
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
});

test('an interrupted CAS displacement restores the original before any new publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-cas-recovery-'));
  const filePath = join(root, 'config.toml');
  const transactionDir = join(root, '.config.toml.eric-task-master-cas');
  await writeFile(filePath, 'displaced-original\n', 'utf8');
  await mkdir(transactionDir, { mode: 0o700 });
  await rename(filePath, join(transactionDir, 'original'));
  const expectedAbsent = await readOptionalFile(filePath);

  await assert.rejects(
    atomicWriteCas(filePath, 'must-not-publish\n', { expected: expectedAbsent }),
    { code: 'CONFIG_CAS_MISMATCH' }
  );
  assert.equal(await readFile(filePath, 'utf8'), 'displaced-original\n');
  await assert.rejects(lstat(transactionDir), { code: 'ENOENT' });
});

test('automatic rollback reports a real conflict and remains explicitly retryable', async () => {
  const setup = await fixture();
  const before = await snapshot(setup.paths);
  let afterCodexWrite;
  const registrar = createRegistrar({
    env: setup.env,
    platform: 'win32',
    home: setup.home,
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    entrypoint: setup.entrypoint,
    executablePath: process.execPath,
    async writeHostFile(filePath, bytes, options) {
      if (filePath === setup.paths['claude-desktop']) {
        afterCodexWrite = await readFile(setup.paths.codex, 'utf8');
        await writeFile(setup.paths.codex, `${afterCodexWrite.trimEnd()}\n# EDITED_DURING_FAILURE\n`, 'utf8');
        throw Object.assign(new Error('injected second-host failure'), { code: 'INJECTED_WRITE_FAILURE' });
      }
      return atomicWriteCas(filePath, bytes, options);
    }
  });
  const result = await registrar.install({ hostKeys: ['codex', 'claude-desktop'] });
  assert.equal(result.ok, false);
  assert.equal(result.changed, true);
  assert.equal(result.rollback.ok, false);
  assert.equal(result.rollback.remainingChanged, true);
  assert.equal(result.rollback.conflicts[0].hostKey, 'codex');
  assert.match(await readFile(setup.paths.codex, 'utf8'), /EDITED_DURING_FAILURE/);
  const state = JSON.parse(await readFile(registrar.statePath, 'utf8'));
  assert.equal(state.transactions.at(-1).status, 'rollback_conflicted');
  assert.ok(state.registrations.codex);

  await writeFile(setup.paths.codex, afterCodexWrite, 'utf8');
  const retried = await setup.registrar.rollback({ transactionId: result.transactionId });
  assert.equal(retried.ok, true);
  assert.equal(retried.remainingChanged, false);
  assert.equal(await readFile(setup.paths.codex, 'utf8'), before.codex);
  assert.equal(await readFile(setup.paths['claude-desktop'], 'utf8'), before['claude-desktop']);
});

test('explicit rollback reports per-host failure and retries only unfinished actions', async () => {
  const setup = await fixture();
  const before = await snapshot(setup.paths);
  const installed = await setup.registrar.install({ hostKeys: ['codex', 'claude-desktop'] });
  let failCodex = true;
  const flaky = createRegistrar({
    env: setup.env,
    platform: 'win32',
    home: setup.home,
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    entrypoint: setup.entrypoint,
    executablePath: process.execPath,
    async writeHostFile(filePath, bytes, options) {
      if (filePath === setup.paths.codex && failCodex) {
        failCodex = false;
        throw Object.assign(new Error('injected rollback failure'), { code: 'INJECTED_ROLLBACK_FAILURE' });
      }
      return atomicWriteCas(filePath, bytes, options);
    }
  });
  const first = await flaky.rollback({ transactionId: installed.transactionId });
  assert.equal(first.ok, false);
  assert.equal(first.remainingChanged, true);
  assert.equal(first.results.find((item) => item.hostKey === 'codex').status, 'rollback_failed');
  assert.equal(first.results.find((item) => item.hostKey === 'claude-desktop').status, 'rolled_back');

  const retried = await setup.registrar.rollback({ transactionId: installed.transactionId });
  assert.equal(retried.ok, true);
  assert.equal(retried.results.find((item) => item.hostKey === 'claude-desktop').status, 'already_rolled_back');
  assert.equal(retried.results.find((item) => item.hostKey === 'codex').status, 'rolled_back');
  assert.equal(await readFile(setup.paths.codex, 'utf8'), before.codex);
  assert.equal(await readFile(setup.paths['claude-desktop'], 'utf8'), before['claude-desktop']);
});

test('startup recovers a prepared or applying transaction before reporting status', async () => {
  const setup = await fixture();
  const original = await readFile(setup.paths.codex, 'utf8');
  const installed = await setup.registrar.install({ hostKeys: ['codex'] });
  const state = JSON.parse(await readFile(setup.registrar.statePath, 'utf8'));
  const transaction = state.transactions.find((item) => item.id === installed.transactionId);
  transaction.status = 'applying';
  transaction.currentHostKey = 'codex';
  transaction.actions[0].status = 'applied';
  await writeFile(setup.registrar.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const status = await setup.registrar.status({ hostKeys: ['codex'] });
  assert.equal(status.ok, true);
  assert.equal(status.results[0].status, 'unregistered');
  assert.equal(await readFile(setup.paths.codex, 'utf8'), original);
  const recovered = JSON.parse(await readFile(setup.registrar.statePath, 'utf8'));
  assert.equal(recovered.transactions.find((item) => item.id === installed.transactionId).status, 'rolled_back_after_recovery');
  assert.equal(recovered.registrations.codex, undefined);
});

test('startup fails closed when an interrupted transaction meets an unknown host edit', async () => {
  const setup = await fixture();
  const installed = await setup.registrar.install({ hostKeys: ['codex'] });
  const state = JSON.parse(await readFile(setup.registrar.statePath, 'utf8'));
  const transaction = state.transactions.find((item) => item.id === installed.transactionId);
  transaction.status = 'applying';
  transaction.currentHostKey = 'codex';
  transaction.actions[0].status = 'applied';
  await writeFile(setup.registrar.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const externallyEdited = `${await readFile(setup.paths.codex, 'utf8')}\n# user edit after interrupted write\n`;
  await writeFile(setup.paths.codex, externallyEdited, 'utf8');

  await assert.rejects(
    setup.registrar.status({ hostKeys: ['codex'] }),
    { code: 'REGISTRATION_RECOVERY_REQUIRED', transactionId: installed.transactionId }
  );
  assert.equal(await readFile(setup.paths.codex, 'utf8'), externallyEdited);
  const conflicted = JSON.parse(await readFile(setup.registrar.statePath, 'utf8'));
  const recovered = conflicted.transactions.find((item) => item.id === installed.transactionId);
  assert.equal(recovered.status, 'recovery_conflicted');
  assert.equal(recovered.rollbackConflicts[0].hostKey, 'codex');
});

test('quoted TOML and YAML server names conflict, while duplicate semantic keys fail closed', async () => {
  const tomlQuoted = await fixture();
  await write(tomlQuoted.paths.codex, [
    "[mcp_servers.'eric-task-master']",
    'command = "foreign"',
    ''
  ].join('\n'));
  const tomlBefore = await readFile(tomlQuoted.paths.codex, 'utf8');
  const tomlResult = await tomlQuoted.registrar.install({ hostKeys: ['codex'] });
  assert.equal(tomlResult.ok, false);
  assert.equal(tomlResult.results[0].error.code, 'REGISTRATION_CONFLICT');
  assert.equal(await readFile(tomlQuoted.paths.codex, 'utf8'), tomlBefore);

  const yamlQuoted = await fixture();
  await write(yamlQuoted.paths.hermes, [
    '"mcp_servers":',
    "  'eric-task-master':",
    '    command: "foreign"',
    ''
  ].join('\n'));
  const yamlBefore = await readFile(yamlQuoted.paths.hermes, 'utf8');
  const yamlResult = await yamlQuoted.registrar.install({ hostKeys: ['hermes'] });
  assert.equal(yamlResult.ok, false);
  assert.equal(yamlResult.results[0].error.code, 'REGISTRATION_CONFLICT');
  assert.equal(await readFile(yamlQuoted.paths.hermes, 'utf8'), yamlBefore);

  const duplicateToml = await fixture();
  await write(duplicateToml.paths.codex, [
    '[mcp_servers.eric-task-master]',
    'command = "one"',
    "[mcp_servers.'eric-task-master']",
    'command = "two"',
    ''
  ].join('\n'));
  const duplicateResult = await duplicateToml.registrar.install({ hostKeys: ['codex'] });
  assert.equal(duplicateResult.ok, false);
  assert.equal(duplicateResult.results[0].error.code, 'INVALID_HOST_CONFIG');

  const flowYaml = await fixture();
  await write(flowYaml.paths.hermes, 'mcp_servers: { "eric-task-master": { command: "foreign" } }\n');
  const flowResult = await flowYaml.registrar.install({ hostKeys: ['hermes'] });
  assert.equal(flowResult.ok, false);
  assert.equal(flowResult.results[0].error.code, 'INVALID_HOST_CONFIG');
});

test('registration refuses a symlink config without replacing the link or target', async (t) => {
  const setup = await fixture();
  const target = join(setup.root, 'foreign.toml');
  await write(target, '[mcp_servers.foreign]\ncommand = "keep"\n');
  await rm(setup.paths.codex, { force: true });
  try {
    await symlink(target, setup.paths.codex, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`file symlinks unavailable on this runner: ${error.code}`);
      return;
    }
    throw error;
  }
  const before = await readFile(target, 'utf8');
  const result = await setup.registrar.install({ hostKeys: ['codex'] });
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(result.results[0].error.code, 'CONFIG_SYMLINK_UNSUPPORTED');
  assert.equal(await readFile(target, 'utf8'), before);
  assert.equal((await lstat(setup.paths.codex)).isSymbolicLink(), true);
});

test('explicit relocation unlocks a moved checkout without changing installation identity', async () => {
  const setup = await fixture();
  const installed = await setup.registrar.install({ hostKeys: ['codex'] });
  const movedRoot = join(setup.root, 'Moved Project');
  const movedEntrypoint = join(movedRoot, 'src', 'mcp', 'stdio.mjs');
  await write(movedEntrypoint, '// moved isolated entrypoint\n');
  const moved = createRegistrar({
    env: setup.env,
    platform: 'win32',
    home: setup.home,
    projectRoot: movedRoot,
    stateDir: setup.stateDir,
    entrypoint: movedEntrypoint,
    executablePath: process.execPath
  });
  await assert.rejects(moved.status({ hostKeys: ['codex'] }), { code: 'INSTALLATION_ROOT_MISMATCH' });
  const refused = await moved.relocate({ fromProjectRoot: join(setup.root, 'wrong') });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'RELOCATION_SOURCE_MISMATCH');
  const relocated = await moved.relocate({ fromProjectRoot: setup.projectRoot });
  assert.equal(relocated.ok, true);
  assert.equal(relocated.installationId, installed.installationId);
  assert.equal((await moved.status({ hostKeys: ['codex'] })).results[0].status, 'update_available');
  const updated = await moved.install({ hostKeys: ['codex'] });
  assert.equal(updated.ok, true);
  assert.equal(updated.installationId, installed.installationId);
  assert.ok((await readFile(setup.paths.codex, 'utf8')).includes(JSON.stringify(movedEntrypoint)));
});

test('backup pruning failure cannot turn a committed install or relocation into false failure', async () => {
  const setup = await fixture();
  const warnings = [];
  const pruningFailure = async () => {
    throw Object.assign(new Error('injected retention cleanup failure'), { code: 'INJECTED_PRUNE_FAILURE' });
  };
  const registrar = createRegistrar({
    env: setup.env,
    platform: 'win32',
    home: setup.home,
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    entrypoint: setup.entrypoint,
    executablePath: process.execPath,
    pruneBackups: pruningFailure,
    onMaintenanceWarning: (warning) => warnings.push(warning)
  });
  const installed = await registrar.install({ hostKeys: ['codex'] });
  assert.equal(installed.ok, true);
  assert.equal(JSON.parse(await readFile(registrar.statePath, 'utf8')).transactions.at(-1).status, 'complete');

  const movedRoot = join(setup.root, 'Moved Root');
  const movedEntrypoint = join(movedRoot, 'src', 'mcp', 'stdio.mjs');
  await write(movedEntrypoint, '// moved entrypoint\n');
  const moved = createRegistrar({
    env: setup.env,
    platform: 'win32',
    home: setup.home,
    projectRoot: movedRoot,
    stateDir: setup.stateDir,
    entrypoint: movedEntrypoint,
    executablePath: process.execPath,
    pruneBackups: pruningFailure,
    onMaintenanceWarning: (warning) => warnings.push(warning)
  });
  const relocated = await moved.relocate({ fromProjectRoot: setup.projectRoot });
  assert.equal(relocated.ok, true);
  assert.equal(JSON.parse(await readFile(moved.statePath, 'utf8')).projectRoot, resolve(movedRoot));
  assert.ok(warnings.length >= 2);
  assert.ok(warnings.every((warning) => warning.code === 'INJECTED_PRUNE_FAILURE'));
});

test('Windows project-root comparison accepts casing changes for the same installation', async () => {
  const setup = await fixture('win32');
  await setup.registrar.install({ hostKeys: ['codex'] });
  const state = JSON.parse(await readFile(setup.registrar.statePath, 'utf8'));
  state.projectRoot = state.projectRoot.toUpperCase();
  await writeFile(setup.registrar.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const status = await setup.registrar.status({ hostKeys: ['codex'] });
  assert.equal(status.ok, true);
  assert.equal(status.results[0].status, 'registered');
});

test('transaction journal and exact backups retain only the newest twenty rollback points', async () => {
  const setup = await fixture();
  for (let index = 0; index < 11; index += 1) {
    const installed = await setup.registrar.install({ hostKeys: ['codex'] });
    assert.equal(installed.ok, true);
    const removed = await setup.registrar.uninstall({ hostKeys: ['codex'] });
    assert.equal(removed.ok, true);
  }
  const state = JSON.parse(await readFile(setup.registrar.statePath, 'utf8'));
  assert.equal(state.transactions.length, 20);
  const backupEntries = await readdir(join(setup.stateDir, 'backups'), { withFileTypes: true });
  assert.equal(backupEntries.filter((entry) => entry.isDirectory()).length, 20);
});
