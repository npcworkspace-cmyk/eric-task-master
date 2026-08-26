import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { adapterFor, desiredEntry } from '../../src/registration/formats.mjs';
import { createHostDefinitions } from '../../src/registration/hosts.mjs';

async function temporaryHome() {
  return mkdtemp(join(tmpdir(), 'taskmaster-json-hosts-'));
}

async function write(filePath, source = '{}\n') {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, source, 'utf8');
}

function hostByKey(home, key, env = {}, platform = 'win32') {
  return createHostDefinitions({ home, env: { PATH: '', ...env }, platform })
    .find((host) => host.key === key);
}

function adapterContext(host, installationId = '00000000-0000-4000-8000-000000000001') {
  const desired = desiredEntry(host, installationId, process.execPath, join('project', 'src', 'mcp', 'stdio.mjs'));
  return {
    host,
    filePath: host.configPath || 'isolated-host.json',
    desired,
    clientId: desired.env.TASKMASTER_CLIENT_ID,
    ...(host.managedEntryKeys ? { managedEntryKeys: host.managedEntryKeys } : {}),
    ...(host.managedEnvKeys ? { managedEnvKeys: host.managedEnvKeys } : {})
  };
}

test('strict JSON and CodeBuddy JSONC reject duplicate object keys without leaking keys or values', async () => {
  const home = await temporaryHome();
  const strict = adapterFor('json');
  const jsonc = adapterFor('jsonc');
  const strictContext = adapterContext(hostByKey(home, 'claude-desktop', {
    TASKMASTER_CLAUDE_DESKTOP_CONFIG: join(home, 'claude.json')
  }));
  const jsoncContext = adapterContext(hostByKey(home, 'codebuddy-cli'));
  const sources = [
    '{"mcpServers":{},"mcpServers":{"hidden-root":"ROOT_SECRET"}}',
    '{"mcpServers":{"eric-task-master":{"command":"one"},"eric-task-master":{"command":"ENTRY_SECRET"}}}',
    '{"settings":{"nested":"one","n\\u0065sted":"NESTED_SECRET"}}',
    '{/* comment */"mcpServers":{},"mcpServers":{"hidden":"JSONC_SECRET"},}'
  ];

  for (const [index, source] of sources.entries()) {
    const adapter = index === sources.length - 1 ? jsonc : strict;
    const context = index === sources.length - 1 ? jsoncContext : strictContext;
    assert.throws(() => adapter.inspect(source, context), (error) => {
      assert.equal(error.code, 'INVALID_HOST_CONFIG');
      assert.doesNotMatch(error.message, /mcpServers|eric-task-master|hidden-root|nested|SECRET/u);
      return true;
    });
  }
});

test('only CodeBuddy uses JSONC and its comments and trailing commas normalize without losing settings', async () => {
  const home = await temporaryHome();
  const codeBuddy = hostByKey(home, 'codebuddy-cli');
  const claude = hostByKey(home, 'claude-desktop', {
    TASKMASTER_CLAUDE_DESKTOP_CONFIG: join(home, 'claude.json')
  });
  const gemini = hostByKey(home, 'gemini-cli');
  assert.equal(codeBuddy.format, 'jsonc');
  assert.equal(claude.format, 'json');
  assert.equal(gemini.format, 'json');

  const source = `{
    // user-facing preferences must survive
    "locale": "zh-CN",
    "features": { "alpha": true, },
    "mcpServers": {
      "existing": { "command": "keep", "args": ["--safe",], },
    },
  }`;
  const context = adapterContext(codeBuddy);
  const installed = adapterFor(codeBuddy.format).install(source, context);
  const parsed = JSON.parse(installed);
  assert.equal(parsed.locale, 'zh-CN');
  assert.deepEqual(parsed.features, { alpha: true });
  assert.deepEqual(parsed.mcpServers.existing, { command: 'keep', args: ['--safe'] });
  assert.ok(parsed.mcpServers['eric-task-master']);
  assert.throws(
    () => adapterFor(claude.format).inspect(source, adapterContext(claude)),
    { code: 'INVALID_HOST_CONFIG' }
  );
});

test('CodeBuddy USER config selection follows documented precedence and explicit isolation override', async () => {
  const home = await temporaryHome();
  const codeBuddyHome = join(home, '.codebuddy');
  const dotMcp = join(codeBuddyHome, '.mcp.json');
  const mcp = join(codeBuddyHome, 'mcp.json');
  const legacy = join(codeBuddyHome, '.codebuddy.json');
  const override = join(home, 'isolated', 'codebuddy.jsonc');

  assert.equal(hostByKey(home, 'codebuddy-cli').configPath, resolve(dotMcp));
  await write(legacy);
  assert.equal(hostByKey(home, 'codebuddy-cli').configPath, resolve(legacy));
  await write(mcp);
  assert.equal(hostByKey(home, 'codebuddy-cli').configPath, resolve(mcp));
  await write(dotMcp);
  assert.equal(hostByKey(home, 'codebuddy-cli').configPath, resolve(dotMcp));
  assert.equal(hostByKey(home, 'codebuddy-cli', {
    CODEBUDDY_MCP_CONFIG: override
  }).configPath, resolve(override));
});

test('WorkBuddy accepts only WORKBUDDY_HOME mcp.json and rejects proxy, approval, nested, or outside paths', async () => {
  const home = await temporaryHome();
  const workBuddyHome = join(home, 'workbuddy');
  const accepted = join(workBuddyHome, 'mcp.json');
  assert.equal(hostByKey(home, 'workbuddy', {
    WORKBUDDY_HOME: workBuddyHome,
    WORKBUDDY_MCP_CONFIG: accepted
  }).configPath, resolve(accepted));

  for (const candidate of [
    join(workBuddyHome, '.mcp.json'),
    join(workBuddyHome, 'mcp-approvals.json'),
    join(workBuddyHome, 'nested', 'mcp.json'),
    join(home, 'outside', 'mcp.json')
  ]) {
    assert.throws(() => hostByKey(home, 'workbuddy', {
      WORKBUDDY_HOME: workBuddyHome,
      WORKBUDDY_MCP_CONFIG: candidate
    }), { code: 'WORKBUDDY_RESERVED_CONFIG_PATH' });
  }
  assert.throws(() => hostByKey(home, 'workbuddy', {
    WORKBUDDY_HOME: workBuddyHome,
    WORKBUDDY_MCP_CONFIG: join(workBuddyHome, 'MCP.JSON')
  }, 'linux'), { code: 'WORKBUDDY_RESERVED_CONFIG_PATH' });
  assert.throws(() => hostByKey(home, 'workbuddy', {
    WORKBUDDY_MCP_CONFIG: join(home, 'unrelated-host', 'mcp.json')
  }), { code: 'WORKBUDDY_RESERVED_CONFIG_PATH' });
});

test('WorkBuddy owned updates patch only managed runtime fields and preserve host metadata', async () => {
  const home = await temporaryHome();
  const workBuddyHome = join(home, 'workbuddy');
  const host = hostByKey(home, 'workbuddy', { WORKBUDDY_HOME: workBuddyHome });
  const context = adapterContext(host);
  const source = JSON.stringify({
    theme: 'dark',
    mcpServers: {
      existing: { command: 'keep' },
      'eric-task-master': {
        command: 'old-node',
        args: ['old-entrypoint'],
        env: {
          ERIC_TASK_MASTER_CLIENT_ID: context.clientId,
          ERIC_TASK_MASTER_CLIENT_NAME: 'old-name',
          TASKMASTER_CLIENT_ID: context.clientId,
          TASKMASTER_CLIENT_NAME: 'old-name',
          WORKBUDDY_RUNTIME_HINT: 'preserve-me'
        },
        description: 'User-owned label',
        disabled: true,
        hostMetadata: { color: 'blue' }
      }
    }
  });

  const updated = JSON.parse(adapterFor(host.format).install(source, context));
  const entry = updated.mcpServers['eric-task-master'];
  assert.equal(updated.theme, 'dark');
  assert.deepEqual(updated.mcpServers.existing, { command: 'keep' });
  assert.equal(entry.command, context.desired.command);
  assert.deepEqual(entry.args, context.desired.args);
  for (const envKey of host.managedEnvKeys) {
    assert.equal(entry.env[envKey], context.desired.env[envKey]);
  }
  assert.equal(entry.env.WORKBUDDY_RUNTIME_HINT, 'preserve-me');
  assert.equal(entry.description, 'User-owned label');
  assert.equal(entry.disabled, true);
  assert.deepEqual(entry.hostMetadata, { color: 'blue' });

  const initial = JSON.parse(adapterFor(host.format).install('{}', context));
  assert.equal(initial.mcpServers['eric-task-master'].description, 'Eric Task Master');
  assert.equal(initial.mcpServers['eric-task-master'].disabled, false);
});
