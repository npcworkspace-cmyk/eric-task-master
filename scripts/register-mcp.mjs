#!/usr/bin/env node
import { createRegistrar } from '../src/registration/index.mjs';

const HELP = `Eric Task Master MCP host registration

Usage:
  node scripts/register-mcp.mjs status [--hosts LIST] [--json]
  node scripts/register-mcp.mjs install [--dry-run] [--hosts LIST] [--json]
  node scripts/register-mcp.mjs uninstall [--dry-run] [--hosts LIST] [--json]
  node scripts/register-mcp.mjs rollback [--transaction ID] [--dry-run] [--json]
  node scripts/register-mcp.mjs relocate --from PREVIOUS_PROJECT_ROOT [--json]

Options:
  --hosts LIST       Comma-separated host keys (default: all known hosts)
  --home PATH        Override the detected user home
  --state-dir PATH   Override registration ownership and backup storage
  --entrypoint PATH  Override src/mcp/stdio.mjs (advanced/testing)
  --node PATH        Override the absolute Node.js executable
  --from PATH        Confirm the previous project root for an explicit relocation
  --dry-run          Report changes without writing host or state files
  --json             Emit compact machine-readable JSON

Verified automatic MCP registration:
  codex, claude-desktop, claude-code, workbuddy, codebuddy-cli,
  hermes, gemini-cli, openclaw

MCP capability reported without speculative host writes:
  dsh, pi, vscode-copilot, opencode
`;

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf('=');
    const key = value.slice(2, equals === -1 ? undefined : equals);
    if (equals !== -1) {
      options[key] = value.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { positionals, options };
}

function emit(value, compact) {
  process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

const { positionals, options } = parseArgs(process.argv.slice(2));
const command = positionals[0];

if (!command || options.help || options.h) {
  process.stdout.write(HELP);
  process.exit(0);
}

try {
  const registrar = createRegistrar({
    ...(options.home ? { home: options.home } : {}),
    ...(options['state-dir'] ? { stateDir: options['state-dir'] } : {}),
    ...(options.entrypoint ? { entrypoint: options.entrypoint } : {}),
    ...(options.node ? { executablePath: options.node } : {})
  });
  const common = {
    dryRun: options['dry-run'] === true,
    ...(options.hosts ? { hostKeys: options.hosts } : {})
  };
  let result;
  if (command === 'status') result = await registrar.status(common);
  else if (command === 'install') result = await registrar.install(common);
  else if (command === 'uninstall') result = await registrar.uninstall(common);
  else if (command === 'rollback') {
    result = await registrar.rollback({
      dryRun: common.dryRun,
      ...(options.transaction ? { transactionId: options.transaction } : {})
    });
  } else if (command === 'relocate') {
    result = await registrar.relocate({ fromProjectRoot: options.from });
  } else {
    throw Object.assign(new Error(`Unknown command: ${command}`), { code: 'UNKNOWN_COMMAND' });
  }
  emit(result, options.json === true);
  if (!result.ok) process.exitCode = 2;
} catch (error) {
  emit({
    ok: false,
    command,
    changed: false,
    error: { code: error.code || 'REGISTRATION_FAILED', message: error.message }
  }, options.json === true);
  process.exitCode = 2;
}
