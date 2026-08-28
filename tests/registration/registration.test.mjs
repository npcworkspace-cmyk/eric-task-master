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
import { fingerprint } from '../../src/registration/formats.mjs';
import { RegistrationLock } from '../../src/registration/lock.mjs';
import { createOfficialCliAdapter, runHostCommand } from '../../src/registration/official-cli.mjs';
import { VERSION } from '../../src/contracts.mjs';

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
  const workBuddyHome = join(home, 'WorkBuddy 自定义');
  const workBuddyConfig = join(workBuddyHome, 'mcp.json');
  const protectedPaths = {
    workbuddyProxy: join(workBuddyHome, '.mcp.json'),
    workbuddyApprovals: join(workBuddyHome, 'mcp-approvals.json')
  };
  const env = {
    HOME: home,
    USERPROFILE: home,
    PATH: '',
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    HERMES_HOME: hermesHome,
    WORKBUDDY_HOME: workBuddyHome,
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
  await write(protectedPaths.workbuddyProxy, `${JSON.stringify({
    mcpServers: { 'connector-proxy': { type: 'http', url: 'http://127.0.0.1:1/mcp' } }
  }, null, 2)}\n`);
  await write(protectedPaths.workbuddyApprovals, '{"approval-hash::existing":1}\n');
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
  return { root, home, projectRoot, stateDir, env, entrypoint, paths, protectedPaths, registrar };
}

async function snapshot(paths) {
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, 'utf8')])));
}

function registrarFor(setup, overrides = {}) {
  return createRegistrar({
    env: setup.env,
    platform: 'win32',
    home: setup.home,
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    entrypoint: setup.entrypoint,
    executablePath: process.execPath,
    ...overrides
  });
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

test('dry-run plans all detected verified hosts without writing state or configs', async () => {
  const setup = await fixture();
  const before = await snapshot(setup.paths);
  const result = await setup.registrar.install({ dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.results.filter((item) => item.status === 'would_register').length, 5);
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
  assert.equal(result.results.filter((item) => item.status === 'would_register').length, 5);
  assert.deepEqual(await snapshot(setup.paths), before);
  await assert.rejects(readFile(setup.registrar.statePath, 'utf8'), { code: 'ENOENT' });
});

test('install merges five verified host configs including WorkBuddy and is idempotent', async () => {
  const setup = await fixture();
  const protectedBefore = await Promise.all(Object.values(setup.protectedPaths).map((path) => readFile(path, 'utf8')));
  const first = await setup.registrar.install();
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.results.filter((item) => item.status === 'registered_pending_restart').length, 4);
  assert.equal(first.results.find((item) => item.hostKey === 'workbuddy').status, 'registered_pending_approval_or_reload');
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
  assert.ok(workbuddy.mcpServers['eric-task-master']);
  assert.equal(workbuddy.mcpServers['eric-task-master'].type, undefined);
  assert.equal(workbuddy.mcpServers['eric-task-master'].disabled, false);
  assert.equal(workbuddy.mcpServers['eric-task-master'].description, 'Eric Task Master');
  assert.equal(workbuddy.mcpServers['eric-task-master'].env.NODE_OPTIONS, '');
  assert.equal(desktop.mcpServers['eric-task-master'].env.NODE_OPTIONS, undefined);
  assert.equal(claudeCode.mcpServers['eric-task-master'].env.NODE_OPTIONS, undefined);
  assert.equal(first.results.find((item) => item.hostKey === 'workbuddy').activationStatus, 'pending_approval_or_reload');

  const clientIds = new Set();
  for (const [hostKey, document] of [
    ['claude-desktop', desktop],
    ['claude-code', claudeCode],
    ['workbuddy', workbuddy]
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
  assert.equal(clientIds.size, 3);

  const afterFirst = await snapshot(setup.paths);
  const second = await setup.registrar.install();
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.results.filter((item) => item.status === 'registered').length, 5);
  assert.deepEqual(await snapshot(setup.paths), afterFirst);

  const status = await setup.registrar.status();
  assert.equal(status.ok, true);
  assert.equal(status.results.filter((item) => item.status === 'registered').length, 5);
  const state = JSON.parse(await readFile(setup.registrar.statePath, 'utf8'));
  assert.equal(state.installationId, first.installationId);
  assert.equal(Object.keys(state.registrations).length, 5);
  assert.ok(state.transactions[0].actions.every((action) => isAbsolute(action.backupPath)));
  assert.deepEqual(
    await Promise.all(Object.values(setup.protectedPaths).map((path) => readFile(path, 'utf8'))),
    protectedBefore
  );
});

test('registration runtime marker is backward compatible and requires one full-install host reload after upgrade', async () => {
  const setup = await fixture();
  const first = await setup.registrar.install();
  assert.equal(first.ok, true);
  assert.equal(first.agentHostReloadRequired, false);
  let state = JSON.parse(await readFile(setup.registrar.statePath, 'utf8'));
  assert.equal(state.runtimeVersion, VERSION);

  delete state.runtimeVersion;
  await writeFile(setup.registrar.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const legacyStateUpgrade = await setup.registrar.install();
  assert.equal(legacyStateUpgrade.ok, true);
  assert.equal(legacyStateUpgrade.changed, false);
  assert.equal(legacyStateUpgrade.previousRuntimeVersion, null);
  assert.equal(legacyStateUpgrade.agentHostReloadRequired, true);
  state = JSON.parse(await readFile(setup.registrar.statePath, 'utf8'));
  assert.equal(state.runtimeVersion, VERSION);

  const repeated = await setup.registrar.install();
  assert.equal(repeated.ok, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.agentHostReloadRequired, false);
});

test('partial registration cannot consume a pending global runtime reload marker', async () => {
  const setup = await fixture();
  const oldRegistrar = registrarFor(setup, { runtimeVersion: '2.1.2' });
  const installed = await oldRegistrar.install();
  assert.equal(installed.ok, true);
  assert.equal(JSON.parse(await readFile(oldRegistrar.statePath, 'utf8')).runtimeVersion, '2.1.2');

  const currentRegistrar = registrarFor(setup, { runtimeVersion: '2.1.3' });
  const partial = await currentRegistrar.install({ hostKeys: ['codex'] });
  assert.equal(partial.ok, true);
  assert.equal(partial.agentHostReloadRequired, true);
  assert.equal(JSON.parse(await readFile(currentRegistrar.statePath, 'utf8')).runtimeVersion, '2.1.2');

  const complete = await currentRegistrar.install();
  assert.equal(complete.ok, true);
  assert.equal(complete.agentHostReloadRequired, true);
  assert.equal(JSON.parse(await readFile(currentRegistrar.statePath, 'utf8')).runtimeVersion, '2.1.3');
  assert.equal((await currentRegistrar.install()).agentHostReloadRequired, false);
});

test('uninstall preserves unrelated later edits and rollback restores the owned entries', async () => {
  const setup = await fixture();
  await setup.registrar.install();
  const desktop = JSON.parse(await readFile(setup.paths['claude-desktop'], 'utf8'));
  desktop.afterInstall = { preserve: true };
  await write(setup.paths['claude-desktop'], `${JSON.stringify(desktop, null, 2)}\n`);

  const removed = await setup.registrar.uninstall();
  assert.equal(removed.ok, true);
  assert.equal(removed.results.filter((item) => item.status === 'unregistered_pending_restart').length, 5);
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
  assert.equal(status.results.filter((item) => item.status === 'registered').length, 5);
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

test('DSH and Pi report their real MCP capability without speculative writes', async () => {
  const setup = await fixture('linux');
  const markerPaths = [join(setup.home, '.dsh', 'marker'), join(setup.home, '.pi', 'marker')];
  for (const marker of markerPaths) await write(marker, 'keep\n');
  const before = await Promise.all(markerPaths.map((path) => readFile(path, 'utf8')));
  const result = await setup.registrar.install({ hostKeys: ['dsh', 'pi'] });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.results.map((item) => item.status), ['adapter_pending', 'extension_required']);
  assert.deepEqual(result.results.map((item) => item.mcpCapability), [
    'mcp_first_party_extension',
    'mcp_extension_required'
  ]);
  assert.ok(result.results.every((item) => item.support === 'needs_adapter'));
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
    assert.equal(hosts['codebuddy-cli'].configPath, resolve(setup.home, '.codebuddy', '.mcp.json'));
    assert.equal(hosts['gemini-cli'].configPath, resolve(setup.home, '.gemini', 'settings.json'));
    assert.ok(hosts['claude-desktop'].configPath.startsWith(setup.home));

    const defaultEnv = { ...setup.env };
    delete defaultEnv.WORKBUDDY_MCP_CONFIG;
    delete defaultEnv.WORKBUDDY_HOME;
    const defaults = createRegistrar({
      env: defaultEnv,
      platform,
      home: setup.home,
      projectRoot: setup.projectRoot,
      stateDir: join(setup.root, `default-paths-${platform}`),
      entrypoint: setup.entrypoint,
      executablePath: process.execPath
    });
    const defaultHosts = Object.fromEntries(defaults.hosts.map((host) => [host.key, host]));
    assert.equal(defaultHosts.workbuddy.configPath, resolve(setup.home, '.workbuddy', 'mcp.json'));
    assert.notEqual(defaultHosts.workbuddy.configPath, resolve(setup.home, '.workbuddy', '.mcp.json'));
  }
});

test('WorkBuddy proxy and approval paths are rejected even when an override points at them', async () => {
  const setup = await fixture();
  for (const reservedPath of Object.values(setup.protectedPaths)) {
    assert.throws(() => registrarFor(setup, {
      env: { ...setup.env, WORKBUDDY_MCP_CONFIG: reservedPath }
    }), { code: 'WORKBUDDY_RESERVED_CONFIG_PATH' });
  }
});

test('WorkBuddy isolates an exact same-install entry while preserving host metadata, proxy, and approvals', async () => {
  const setup = await fixture();
  const installed = await setup.registrar.install({ hostKeys: ['codex'] });
  const clientId = `${installed.installationId}:workbuddy`;
  const clientName = 'Eric Task Master / WorkBuddy Desktop';
  const document = JSON.parse(await readFile(setup.paths.workbuddy, 'utf8'));
  document.mcpServers['eric-task-master'] = {
    command: process.execPath,
    args: [setup.entrypoint],
    env: {
      ERIC_TASK_MASTER_CLIENT_ID: clientId,
      ERIC_TASK_MASTER_CLIENT_NAME: clientName,
      TASKMASTER_CLIENT_ID: clientId,
      TASKMASTER_CLIENT_NAME: clientName,
      WORKBUDDY_RUNTIME_HINT: 'preserve-me'
    },
    description: 'User-managed description',
    disabled: true
  };
  await write(setup.paths.workbuddy, `${JSON.stringify(document, null, 2)}\n`);
  const protectedBefore = await Promise.all(Object.values(setup.protectedPaths).map((path) => readFile(path, 'utf8')));

  const beforeStatus = await setup.registrar.status({ hostKeys: ['workbuddy'] });
  assert.equal(beforeStatus.results[0].status, 'update_available');
  assert.equal(beforeStatus.results[0].configurationStatus, 'registered_outdated');

  const adopted = await setup.registrar.install({ hostKeys: ['workbuddy'] });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.changed, true);
  assert.equal(adopted.results[0].status, 'registered_pending_approval_or_reload');
  const isolated = JSON.parse(await readFile(setup.paths.workbuddy, 'utf8'));
  assert.equal(isolated.mcpServers['eric-task-master'].env.NODE_OPTIONS, '');
  assert.equal(isolated.mcpServers['eric-task-master'].env.WORKBUDDY_RUNTIME_HINT, 'preserve-me');
  assert.equal(isolated.mcpServers['eric-task-master'].description, 'User-managed description');
  assert.equal(isolated.mcpServers['eric-task-master'].disabled, true);
  assert.deepEqual(
    await Promise.all(Object.values(setup.protectedPaths).map((path) => readFile(path, 'utf8'))),
    protectedBefore
  );
  const state = JSON.parse(await readFile(setup.registrar.statePath, 'utf8'));
  assert.equal(state.registrations.workbuddy.clientId, clientId);
  assert.equal((await setup.registrar.status({ hostKeys: ['workbuddy'] })).results[0].status, 'registered');

  const adoptionRollback = await setup.registrar.rollback({ transactionId: adopted.transactionId });
  assert.equal(adoptionRollback.ok, true);
  const rolledBack = JSON.parse(await readFile(setup.paths.workbuddy, 'utf8'));
  assert.equal(rolledBack.mcpServers['eric-task-master'].env.NODE_OPTIONS, undefined);
  assert.equal((await setup.registrar.status({ hostKeys: ['workbuddy'] })).results[0].status, 'update_available');
  const readopted = await setup.registrar.install({ hostKeys: ['workbuddy'] });
  assert.equal(readopted.results[0].status, 'registered_pending_approval_or_reload');

  const removed = await setup.registrar.uninstall({ hostKeys: ['workbuddy'] });
  assert.equal(removed.ok, true);
  const after = JSON.parse(await readFile(setup.paths.workbuddy, 'utf8'));
  assert.equal(after.mcpServers['eric-task-master'], undefined);
  assert.ok(after.mcpServers.existing);
  assert.equal(after.preferences.language, 'zh-CN');
});

test('WorkBuddy isolates a live legacy entry while preserving its absolute Node runtime', async () => {
  const setup = await fixture();
  const installed = await setup.registrar.install({ hostKeys: ['codex'] });
  const clientId = `${installed.installationId}:workbuddy`;
  const workBuddyNode = join(setup.root, 'WorkBuddy Runtime', 'node.exe');
  await write(workBuddyNode, 'fixture runtime\n');
  const document = JSON.parse(await readFile(setup.paths.workbuddy, 'utf8'));
  document.mcpServers['eric-task-master'] = {
    command: workBuddyNode,
    args: [setup.entrypoint],
    env: {
      ERIC_TASK_MASTER_CLIENT_ID: clientId,
      ERIC_TASK_MASTER_CLIENT_NAME: 'Eric Task Master / WorkBuddy',
      TASKMASTER_CLIENT_ID: clientId,
      TASKMASTER_CLIENT_NAME: 'Eric Task Master / WorkBuddy',
      NODE_OPTIONS: '--preserve-host-value'
    },
    description: 'Host-maintained metadata',
    disabled: false
  };
  await write(setup.paths.workbuddy, `${JSON.stringify(document, null, 2)}\n`);
  const status = await setup.registrar.status({ hostKeys: ['workbuddy'] });
  assert.equal(status.results[0].status, 'update_available');
  const dryRun = await setup.registrar.install({ hostKeys: ['workbuddy'], dryRun: true });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.results[0].status, 'would_register');
  const adopted = await setup.registrar.install({ hostKeys: ['workbuddy'] });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.results[0].status, 'registered_pending_approval_or_reload');
  const isolated = JSON.parse(await readFile(setup.paths.workbuddy, 'utf8'));
  assert.equal(isolated.mcpServers['eric-task-master'].command, workBuddyNode);
  assert.equal(isolated.mcpServers['eric-task-master'].env.NODE_OPTIONS, '');
  assert.equal(isolated.mcpServers['eric-task-master'].description, 'Host-maintained metadata');
  assert.equal(isolated.mcpServers['eric-task-master'].disabled, false);

  const state = JSON.parse(await readFile(setup.registrar.statePath, 'utf8'));
  assert.equal(state.registrations.workbuddy.command, workBuddyNode);
  assert.deepEqual(state.registrations.workbuddy.args, [setup.entrypoint]);
  assert.deepEqual(Object.keys(state.registrations.workbuddy.entry.env).sort(), [
    'ERIC_TASK_MASTER_CLIENT_ID',
    'ERIC_TASK_MASTER_CLIENT_NAME',
    'ERIC_TASK_MASTER_RUNTIME_VERSION',
    'NODE_OPTIONS',
    'TASKMASTER_CLIENT_ID',
    'TASKMASTER_CLIENT_NAME'
  ]);
  assert.equal((await setup.registrar.status({ hostKeys: ['workbuddy'] })).results[0].status, 'registered');
  const repeated = await setup.registrar.install({ hostKeys: ['workbuddy'] });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.results[0].status, 'registered');
  assert.deepEqual(JSON.parse(await readFile(setup.paths.workbuddy, 'utf8')), isolated);
});

test('WorkBuddy upgrades a pre-isolation registration without treating its legacy fingerprint as a user edit', async () => {
  const setup = await fixture();
  const oldRuntimeVersion = '2.5.2-test';
  const currentRuntimeVersion = '2.5.3-test';
  const oldRegistrar = registrarFor(setup, { runtimeVersion: oldRuntimeVersion });
  const installed = await oldRegistrar.install({ hostKeys: ['workbuddy'] });
  assert.equal(installed.ok, true);

  const document = JSON.parse(await readFile(setup.paths.workbuddy, 'utf8'));
  const entry = document.mcpServers['eric-task-master'];
  assert.equal(entry.env.NODE_OPTIONS, '');

  const state = JSON.parse(await readFile(oldRegistrar.statePath, 'utf8'));
  const legacyManagedEntry = {
    command: entry.command,
    args: entry.args,
    env: {
      ERIC_TASK_MASTER_CLIENT_ID: entry.env.ERIC_TASK_MASTER_CLIENT_ID,
      ERIC_TASK_MASTER_CLIENT_NAME: entry.env.ERIC_TASK_MASTER_CLIENT_NAME,
      TASKMASTER_CLIENT_ID: entry.env.TASKMASTER_CLIENT_ID,
      TASKMASTER_CLIENT_NAME: entry.env.TASKMASTER_CLIENT_NAME,
      ERIC_TASK_MASTER_RUNTIME_VERSION: entry.env.ERIC_TASK_MASTER_RUNTIME_VERSION
    }
  };
  state.registrations.workbuddy.entryFingerprint = fingerprint(legacyManagedEntry);
  delete state.registrations.workbuddy.entry.env.NODE_OPTIONS;
  await write(oldRegistrar.statePath, `${JSON.stringify(state, null, 2)}\n`);

  const upgradedRegistrar = registrarFor(setup, { runtimeVersion: currentRuntimeVersion });
  const status = await upgradedRegistrar.status({ hostKeys: ['workbuddy'] });
  assert.equal(status.results[0].status, 'update_available');
  const upgraded = await upgradedRegistrar.install({ hostKeys: ['workbuddy'] });
  assert.equal(upgraded.ok, true);
  assert.equal(upgraded.changed, true);
  assert.equal(upgraded.results[0].status, 'registered_pending_approval_or_reload');
  const upgradedEntry = JSON.parse(await readFile(setup.paths.workbuddy, 'utf8'))
    .mcpServers['eric-task-master'];
  assert.equal(upgradedEntry.env.NODE_OPTIONS, '');
  assert.equal(upgradedEntry.env.ERIC_TASK_MASTER_RUNTIME_VERSION, currentRuntimeVersion);
  assert.equal((await upgradedRegistrar.status({ hostKeys: ['workbuddy'] })).results[0].status, 'registered');
  const repeated = await upgradedRegistrar.install({ hostKeys: ['workbuddy'] });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.changed, false);
});

test('WorkBuddy refuses same-command adoption when stable identity names do not match', async () => {
  const setup = await fixture();
  const installed = await setup.registrar.install({ hostKeys: ['codex'] });
  const clientId = `${installed.installationId}:workbuddy`;
  const document = JSON.parse(await readFile(setup.paths.workbuddy, 'utf8'));
  document.mcpServers['eric-task-master'] = {
    command: process.execPath,
    args: [setup.entrypoint],
    env: {
      ERIC_TASK_MASTER_CLIENT_ID: clientId,
      ERIC_TASK_MASTER_CLIENT_NAME: 'wrong-name',
      TASKMASTER_CLIENT_ID: clientId,
      TASKMASTER_CLIENT_NAME: 'wrong-name'
    }
  };
  await write(setup.paths.workbuddy, `${JSON.stringify(document, null, 2)}\n`);
  const before = await readFile(setup.paths.workbuddy, 'utf8');
  const result = await setup.registrar.install({ hostKeys: ['workbuddy'] });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].status, 'conflict');
  assert.equal(result.results[0].error.code, 'OWNED_ENTRY_CHANGED');
  assert.equal(await readFile(setup.paths.workbuddy, 'utf8'), before);
});

test('CodeBuddy CLI and Gemini CLI register transactionally while preserving unrelated settings', async () => {
  const setup = await fixture('linux');
  const codeBuddyPath = join(setup.home, '.codebuddy', '.mcp.json');
  const geminiPath = join(setup.home, '.gemini', 'settings.json');
  setup.env.CODEBUDDY_MCP_CONFIG = codeBuddyPath;
  setup.env.GEMINI_MCP_CONFIG = geminiPath;
  await write(codeBuddyPath, `${JSON.stringify({
    locale: 'zh-CN',
    mcpServers: { existing: { command: 'keep' } }
  }, null, 2)}\n`);
  await write(geminiPath, `${JSON.stringify({
    theme: 'ANSI',
    mcpServers: { existing: { command: 'keep' } }
  }, null, 2)}\n`);
  const registrar = registrarFor(setup, { platform: 'linux' });

  const installed = await registrar.install({ hostKeys: ['codebuddy-cli', 'gemini-cli'] });
  assert.equal(installed.ok, true);
  assert.equal(installed.results.filter((item) => item.status === 'registered_pending_restart').length, 2);
  assert.ok(installed.results.every((item) => item.mcpCapability === 'mcp_native_verified'));
  assert.ok(installed.results.every((item) => item.autoRegistration === 'verified'));
  const codeBuddy = JSON.parse(await readFile(codeBuddyPath, 'utf8'));
  const gemini = JSON.parse(await readFile(geminiPath, 'utf8'));
  assert.equal(codeBuddy.locale, 'zh-CN');
  assert.equal(gemini.theme, 'ANSI');
  assert.ok(codeBuddy.mcpServers['eric-task-master']);
  assert.ok(gemini.mcpServers['eric-task-master']);

  const removed = await registrar.uninstall({ hostKeys: ['codebuddy-cli', 'gemini-cli'] });
  assert.equal(removed.ok, true);
  assert.equal(JSON.parse(await readFile(codeBuddyPath, 'utf8')).locale, 'zh-CN');
  assert.equal(JSON.parse(await readFile(geminiPath, 'utf8')).theme, 'ANSI');
});

test('native MCP hosts without a verified write contract are reported as adapter pending', async () => {
  const setup = await fixture('linux');
  const bin = join(setup.root, 'bin');
  await write(join(bin, 'code'), 'fixture\n');
  await write(join(bin, 'opencode'), 'fixture\n');
  setup.env.PATH = bin;
  const registrar = registrarFor(setup, { platform: 'linux' });
  const result = await registrar.install({ hostKeys: ['vscode-copilot', 'opencode'] });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.results.map((item) => item.status), ['adapter_pending', 'adapter_pending']);
  assert.ok(result.results.every((item) => item.mcpCapability === 'mcp_native_verified'));
  assert.ok(result.results.every((item) => item.autoRegistration === 'adapter_pending'));
  await assert.rejects(readFile(registrar.statePath, 'utf8'), { code: 'ENOENT' });
});

test('Windows OpenClaw npm shims launch without shell interpolation and reject escaping bins', async () => {
  const setup = await fixture('win32');
  const bin = join(setup.root, 'openclaw-bin');
  const packageRoot = join(bin, 'node_modules', 'openclaw');
  const cliPath = join(packageRoot, 'cli.mjs');
  await write(join(bin, 'openclaw.cmd'), '@rem fixture shim that must never execute\n');
  await write(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'openclaw',
    bin: { openclaw: 'cli.mjs' }
  })}\n`);
  await write(cliPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const env = { ...process.env, PATH: bin, PATHEXT: '.CMD' };
  const result = await runHostCommand('openclaw', ['mcp', 'list', '--json'], {
    env,
    platform: 'win32'
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), ['mcp', 'list', '--json']);

  await write(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'openclaw',
    bin: { openclaw: '../escape.mjs' }
  })}\n`);
  await assert.rejects(
    runHostCommand('openclaw', ['mcp', 'list'], { env, platform: 'win32' }),
    { code: 'HOST_CLI_SHIM_UNSUPPORTED' }
  );

  const externalRoot = join(setup.root, 'external-openclaw-bin');
  await write(join(externalRoot, 'cli.mjs'), 'process.stdout.write("escaped");\n');
  await symlink(externalRoot, join(packageRoot, 'linked'), 'junction');
  await write(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'openclaw',
    bin: { openclaw: 'linked/cli.mjs' }
  })}\n`);
  await assert.rejects(
    runHostCommand('openclaw', ['mcp', 'list'], { env, platform: 'win32' }),
    { code: 'HOST_CLI_SHIM_UNSUPPORTED' }
  );

  await write(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'openclaw',
    bin: { openclaw: 'cli.mjs' }
  })}\n`);
  await write(cliPath, 'process.stderr.write("x".repeat(1024 * 1024 + 1));\n');
  await assert.rejects(
    runHostCommand('openclaw', ['mcp', 'list'], { env, platform: 'win32' }),
    { code: 'HOST_CLI_OUTPUT_LIMIT' }
  );

  const sentinel = join(setup.root, 'late-child-write.txt');
  const childSource = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'late'), 600);`;
  await write(cliPath, [
    "import { spawn } from 'node:child_process';",
    `spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'ignore' });`,
    'setTimeout(() => {}, 5000);',
    ''
  ].join('\n'));
  await assert.rejects(
    runHostCommand('openclaw', ['mcp', 'list'], { env, platform: 'win32', timeoutMs: 100 }),
    { code: 'HOST_CLI_TIMEOUT' }
  );
  await delay(900);
  await assert.rejects(readFile(sentinel, 'utf8'), { code: 'ENOENT' });
});

test('OpenClaw inspection uses the complete JSON registry and fails closed on registry load errors', async () => {
  let mutationRan = false;
  const runner = async (_command, args) => {
    if (args[1] === 'list') {
      return { exitCode: 2, signal: null, stdout: '{}' };
    }
    mutationRan = true;
    return { exitCode: 0, signal: null, stdout: '{}' };
  };
  const adapter = createOfficialCliAdapter({ key: 'openclaw', executable: 'openclaw' }, {
    commandRunner: runner,
    platform: 'linux',
    env: {}
  });
  const context = {
    desired: { command: '/usr/bin/node', args: ['/runtime/stdio.mjs'], env: { TASKMASTER_CLIENT_ID: 'install:openclaw' } },
    clientId: 'install:openclaw'
  };
  await assert.rejects(adapter.inspect(context), { code: 'HOST_CLI_COMMAND_FAILED' });
  assert.equal(mutationRan, false);
});

test('OpenClaw rollback performs a final compare before any mutation', async () => {
  const foreign = { command: 'foreign', args: [], env: {} };
  let mutationRan = false;
  const runner = async (_command, args) => {
    if (args[1] === 'list') {
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ 'eric-task-master': foreign }) };
    }
    mutationRan = true;
    return { exitCode: 0, signal: null, stdout: '{}' };
  };
  const adapter = createOfficialCliAdapter({ key: 'openclaw', executable: 'openclaw' }, {
    commandRunner: runner,
    platform: 'linux',
    env: {}
  });
  const context = {
    desired: { command: '/usr/bin/node', args: ['/runtime/stdio.mjs'], env: { TASKMASTER_CLIENT_ID: 'install:openclaw' } },
    clientId: 'install:openclaw'
  };
  await assert.rejects(adapter.restore(context, null, { expectedFingerprint: null }), {
    code: 'HOST_CLI_CAS_MISMATCH'
  });
  assert.equal(mutationRan, false);
});

test('OpenClaw official CLI adapter is idempotent, reversible, and never guesses a config path', async () => {
  const setup = await fixture('linux');
  const bin = join(setup.root, 'bin');
  await write(join(bin, 'openclaw'), 'fixture\n');
  setup.env.PATH = bin;
  let entry = null;
  const calls = [];
  const commandRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (args[1] === 'list') {
      return { exitCode: 0, signal: null, stdout: JSON.stringify(entry ? { 'eric-task-master': entry } : {}) };
    }
    if (args[1] === 'set') {
      entry = JSON.parse(args[3]);
      return { exitCode: 0, signal: null, stdout: '{}' };
    }
    if (args[1] === 'unset') {
      entry = null;
      return { exitCode: 0, signal: null, stdout: '{}' };
    }
    throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
  };
  const registrar = registrarFor(setup, { platform: 'linux', runHostCommand: commandRunner });
  const host = registrar.hosts.find((item) => item.key === 'openclaw');
  assert.equal(host.configPath, undefined);

  const installed = await registrar.install({ hostKeys: ['openclaw'] });
  assert.equal(installed.ok, true);
  assert.equal(installed.results[0].status, 'registered_pending_reload');
  assert.equal(installed.results[0].configurationStatus, 'registered');
  assert.equal(installed.results[0].activationStatus, 'pending_host_reload');
  assert.equal(entry.command, process.execPath);
  assert.deepEqual(entry.args, [setup.entrypoint]);
  assert.equal(entry.env.TASKMASTER_CLIENT_ID, `${installed.installationId}:openclaw`);
  assert.ok(calls.some((call) => call.args[1] === 'set'));

  const second = await registrar.install({ hostKeys: ['openclaw'] });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.results[0].status, 'registered');

  const removed = await registrar.uninstall({ hostKeys: ['openclaw'] });
  assert.equal(removed.ok, true);
  assert.equal(removed.results[0].status, 'unregistered_pending_reload');
  assert.equal(entry, null);

  const restored = await registrar.rollback({ transactionId: removed.transactionId });
  assert.equal(restored.ok, true);
  assert.ok(entry);
  assert.equal((await registrar.status({ hostKeys: ['openclaw'] })).results[0].status, 'registered');
});

test('OpenClaw disabled ownership is reported honestly, never silently enabled, and restores exactly after uninstall rollback', async () => {
  const setup = await fixture('linux');
  const bin = join(setup.root, 'bin');
  await write(join(bin, 'openclaw'), 'fixture\n');
  setup.env.PATH = bin;
  let entry = null;
  let setCalls = 0;
  const commandRunner = async (_command, args) => {
    if (args[1] === 'list') {
      return { exitCode: 0, signal: null, stdout: JSON.stringify(entry ? { 'eric-task-master': entry } : {}) };
    }
    if (args[1] === 'set') {
      entry = JSON.parse(args[3]);
      setCalls += 1;
      return { exitCode: 0, signal: null, stdout: '{}' };
    }
    if (args[1] === 'unset') {
      entry = null;
      return { exitCode: 0, signal: null, stdout: '{}' };
    }
    throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
  };
  const registrar = registrarFor(setup, { platform: 'linux', runHostCommand: commandRunner });
  assert.equal((await registrar.install({ hostKeys: ['openclaw'] })).ok, true);
  entry = {
    ...entry,
    enabled: false,
    cwd: '/disabled/work',
    toolFilter: { include: ['taskmaster_status'] }
  };
  const disabledEntry = structuredClone(entry);
  const status = (await registrar.status({ hostKeys: ['openclaw'] })).results[0];
  assert.equal(status.status, 'registered_disabled');
  assert.equal(status.configurationStatus, 'registered');
  assert.equal(status.activationStatus, 'disabled_by_host');

  const setCallsBeforeRepeat = setCalls;
  const repeated = await registrar.install({ hostKeys: ['openclaw'] });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.results[0].status, 'registered_disabled');
  assert.equal(setCalls, setCallsBeforeRepeat);
  assert.deepEqual(entry, disabledEntry);

  const removed = await registrar.uninstall({ hostKeys: ['openclaw'] });
  assert.equal(removed.ok, true);
  assert.equal(entry, null);
  const restored = await registrar.rollback({ transactionId: removed.transactionId });
  assert.equal(restored.ok, true);
  assert.deepEqual(entry, disabledEntry);
});

test('OpenClaw runtime upgrade preserves complete host metadata and transaction rollback restores it exactly', async () => {
  const setup = await fixture('linux');
  const bin = join(setup.root, 'bin');
  await write(join(bin, 'openclaw'), 'fixture\n');
  setup.env.PATH = bin;
  let entry = null;
  const commandRunner = async (_command, args) => {
    if (args[1] === 'list') {
      return { exitCode: 0, signal: null, stdout: JSON.stringify(entry ? { 'eric-task-master': entry } : {}) };
    }
    if (args[1] === 'set') {
      entry = JSON.parse(args[3]);
      return { exitCode: 0, signal: null, stdout: '{}' };
    }
    if (args[1] === 'unset') {
      entry = null;
      return { exitCode: 0, signal: null, stdout: '{}' };
    }
    throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
  };
  const oldRegistrar = registrarFor(setup, {
    platform: 'linux',
    runHostCommand: commandRunner,
    runtimeVersion: '2.1.2'
  });
  const first = await oldRegistrar.install({ hostKeys: ['openclaw'] });
  assert.equal(first.ok, true);

  entry = {
    ...entry,
    cwd: '/operator/work',
    toolFilter: { include: ['taskmaster_*'] },
    requestTimeoutMs: 12_000,
    connectionTimeoutMs: 3_000,
    supportsParallelToolCalls: true,
    futureHostField: { preserve: true },
    env: { ...entry.env, RETRIES: 3, FEATURE_FLAG: true }
  };
  const beforeUpgrade = structuredClone(entry);
  const newRegistrar = registrarFor(setup, {
    platform: 'linux',
    runHostCommand: commandRunner,
    runtimeVersion: '2.1.3'
  });
  const upgraded = await newRegistrar.install({ hostKeys: ['openclaw'] });
  assert.equal(upgraded.ok, true);
  assert.equal(upgraded.agentHostReloadRequired, true);
  assert.equal(entry.env.ERIC_TASK_MASTER_RUNTIME_VERSION, '2.1.3');
  assert.equal(entry.env.RETRIES, 3);
  assert.equal(entry.env.FEATURE_FLAG, true);
  for (const key of [
    'cwd', 'toolFilter', 'requestTimeoutMs', 'connectionTimeoutMs',
    'supportsParallelToolCalls', 'futureHostField'
  ]) {
    assert.deepEqual(entry[key], beforeUpgrade[key]);
  }

  const rolledBack = await newRegistrar.rollback({ transactionId: upgraded.transactionId });
  assert.equal(rolledBack.ok, true);
  assert.deepEqual(entry, beforeUpgrade);
});

test('a failed OpenClaw CLI write rolls back an earlier file host and any applied CLI entry', async () => {
  const setup = await fixture('linux');
  const bin = join(setup.root, 'bin');
  await write(join(bin, 'openclaw'), 'fixture\n');
  setup.env.PATH = bin;
  const codexBefore = await readFile(setup.paths.codex, 'utf8');
  let entry = null;
  let failSet = true;
  const commandRunner = async (_command, args) => {
    if (args[1] === 'list') {
      return { exitCode: 0, signal: null, stdout: JSON.stringify(entry ? { 'eric-task-master': entry } : {}) };
    }
    if (args[1] === 'set') {
      entry = JSON.parse(args[3]);
      if (failSet) {
        failSet = false;
        return { exitCode: 2, signal: null, stdout: '{}' };
      }
      return { exitCode: 0, signal: null, stdout: '{}' };
    }
    if (args[1] === 'unset') {
      entry = null;
      return { exitCode: 0, signal: null, stdout: '{}' };
    }
    throw new Error('unexpected command');
  };
  const registrar = registrarFor(setup, { platform: 'linux', runHostCommand: commandRunner });
  const result = await registrar.install({ hostKeys: ['codex', 'openclaw'] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'HOST_CLI_COMMAND_FAILED');
  assert.equal(result.rollback.ok, true);
  assert.equal(await readFile(setup.paths.codex, 'utf8'), codexBefore);
  assert.equal(entry, null);
  assert.deepEqual(JSON.parse(await readFile(registrar.statePath, 'utf8')).registrations, {});
});

test('OpenClaw CLI compare-before-write preserves a concurrent foreign entry', async () => {
  const setup = await fixture('linux');
  const bin = join(setup.root, 'bin');
  await write(join(bin, 'openclaw'), 'fixture\n');
  setup.env.PATH = bin;
  let entry = null;
  let listCount = 0;
  const commandRunner = async (_command, args) => {
    if (args[1] === 'list') {
      listCount += 1;
      if (listCount === 2) entry = { command: 'foreign', args: [], env: {} };
      return { exitCode: 0, signal: null, stdout: JSON.stringify(entry ? { 'eric-task-master': entry } : {}) };
    }
    throw new Error('mutation command must not run after a compare-before-write mismatch');
  };
  const registrar = registrarFor(setup, { platform: 'linux', runHostCommand: commandRunner });
  const result = await registrar.install({ hostKeys: ['openclaw'] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'HOST_CLI_CAS_MISMATCH');
  assert.equal(result.rollback.ok, true);
  assert.equal(entry.command, 'foreign');
  assert.deepEqual(JSON.parse(await readFile(registrar.statePath, 'utf8')).registrations, {});
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
