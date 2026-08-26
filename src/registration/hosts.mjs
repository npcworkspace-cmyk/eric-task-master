import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathExists } from './files.mjs';

export const MCP_CAPABILITIES = Object.freeze({
  NATIVE_VERIFIED: 'mcp_native_verified',
  FIRST_PARTY_EXTENSION: 'mcp_first_party_extension',
  EXTENSION_REQUIRED: 'mcp_extension_required'
});

export const REGISTRATION_MODES = Object.freeze({
  FILE: 'file',
  OFFICIAL_CLI: 'official_cli',
  ADAPTER_PENDING: 'adapter_pending',
  EXTENSION_REQUIRED: 'extension_required'
});

function executableCandidates(name, env, platform) {
  const pathEntries = String(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  return pathEntries.flatMap((directory) => extensions.map((extension) => join(directory, `${name}${extension.toLowerCase()}`)));
}

async function detectedBy({ configPath, executable, knownPaths = [], detectionPaths = [], env, platform }) {
  const candidates = [configPath, ...detectionPaths, ...knownPaths];
  if (executable) candidates.push(...executableCandidates(executable, env, platform));
  for (const candidate of candidates) {
    if (candidate && await pathExists(candidate)) return true;
  }
  return false;
}

function desktopConfig(home, env, platform) {
  if (env.TASKMASTER_CLAUDE_DESKTOP_CONFIG) return resolve(env.TASKMASTER_CLAUDE_DESKTOP_CONFIG);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

function verifiedFileHost(definition) {
  return {
    mcpCapability: MCP_CAPABILITIES.NATIVE_VERIFIED,
    registrationMode: REGISTRATION_MODES.FILE,
    ...definition
  };
}

function pendingHost(definition) {
  return {
    registrationMode: REGISTRATION_MODES.ADAPTER_PENDING,
    ...definition
  };
}

function samePath(left, right, platform) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function workBuddyConfigPath(workBuddyHome, env, platform) {
  const candidate = resolve(env.WORKBUDDY_MCP_CONFIG || join(workBuddyHome, 'mcp.json'));
  const candidateName = basename(candidate);
  const validName = platform === 'win32'
    ? candidateName.toLocaleLowerCase('en-US') === 'mcp.json'
    : candidateName === 'mcp.json';
  if (
    !validName
    || !samePath(dirname(candidate), workBuddyHome, platform)
  ) {
    throw Object.assign(new Error('WorkBuddy MCP configuration must be the mcp.json file inside WORKBUDDY_HOME'), {
      code: 'WORKBUDDY_RESERVED_CONFIG_PATH'
    });
  }
  return candidate;
}

function codeBuddyConfigPath(codeBuddyHome, env) {
  if (env.CODEBUDDY_MCP_CONFIG) return resolve(env.CODEBUDDY_MCP_CONFIG);
  const candidates = ['.mcp.json', 'mcp.json', '.codebuddy.json']
    .map((name) => join(codeBuddyHome, name));
  return resolve(candidates.find((candidate) => existsSync(candidate)) || candidates[0]);
}

export function createHostDefinitions({ home, env, platform }) {
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const xdgConfigHome = env.XDG_CONFIG_HOME || join(home, '.config');
  const codexHome = resolve(env.CODEX_HOME || join(home, '.codex'));
  const claudeConfig = env.CLAUDE_CONFIG_DIR
    ? join(resolve(env.CLAUDE_CONFIG_DIR), '.claude.json')
    : join(home, '.claude.json');
  const workBuddyHome = resolve(env.WORKBUDDY_HOME || join(home, '.workbuddy'));
  const codeBuddyHome = resolve(env.CODEBUDDY_HOME || join(home, '.codebuddy'));
  const hermesHome = resolve(env.HERMES_HOME || join(home, '.hermes'));
  const geminiHome = resolve(env.GEMINI_CLI_HOME || join(home, '.gemini'));
  const definitions = [
    verifiedFileHost({
      key: 'codex',
      displayName: 'Codex',
      format: 'toml',
      configPath: resolve(env.TASKMASTER_CODEX_CONFIG || join(codexHome, 'config.toml')),
      executable: 'codex',
      knownPaths: platform === 'darwin'
        ? ['/Applications/Codex.app']
        : platform === 'win32' ? [join(localAppData, 'Microsoft', 'WindowsApps', 'codex.exe')] : []
    }),
    verifiedFileHost({
      key: 'claude-desktop',
      displayName: 'Claude Desktop',
      format: 'json',
      configPath: desktopConfig(home, env, platform),
      executable: null,
      knownPaths: platform === 'darwin'
        ? ['/Applications/Claude.app']
        : platform === 'win32'
          ? [join(localAppData, 'Programs', 'Claude', 'Claude.exe'), join(localAppData, 'AnthropicClaude', 'Claude.exe')]
          : []
    }),
    verifiedFileHost({
      key: 'claude-code',
      displayName: 'Claude Code',
      format: 'json',
      configPath: resolve(env.TASKMASTER_CLAUDE_CODE_CONFIG || claudeConfig),
      executable: 'claude',
      knownPaths: []
    }),
    verifiedFileHost({
      key: 'workbuddy',
      displayName: 'WorkBuddy Desktop',
      format: 'json',
      configPath: workBuddyConfigPath(workBuddyHome, env, platform),
      executable: 'workbuddy',
      includeType: false,
      entryDefaults: { description: 'Eric Task Master', disabled: false },
      managedEntryKeys: ['command', 'args', 'env'],
      managedEnvKeys: [
        'ERIC_TASK_MASTER_CLIENT_ID',
        'ERIC_TASK_MASTER_CLIENT_NAME',
        'TASKMASTER_CLIENT_ID',
        'TASKMASTER_CLIENT_NAME',
        'ERIC_TASK_MASTER_RUNTIME_VERSION'
      ],
      installedStatus: 'registered_pending_approval_or_reload',
      knownPaths: platform === 'darwin'
        ? ['/Applications/WorkBuddy.app']
        : platform === 'win32' ? [join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')] : []
    }),
    verifiedFileHost({
      key: 'codebuddy-cli',
      displayName: 'CodeBuddy CLI',
      format: 'jsonc',
      configPath: codeBuddyConfigPath(codeBuddyHome, env),
      executable: 'codebuddy',
      knownPaths: []
    }),
    verifiedFileHost({
      key: 'hermes',
      displayName: 'Hermes Agent',
      format: 'yaml',
      configPath: resolve(env.TASKMASTER_HERMES_CONFIG || join(hermesHome, 'config.yaml')),
      executable: 'hermes',
      knownPaths: []
    }),
    verifiedFileHost({
      key: 'gemini-cli',
      displayName: 'Gemini CLI',
      format: 'json',
      configPath: resolve(env.GEMINI_MCP_CONFIG || join(geminiHome, 'settings.json')),
      executable: 'gemini',
      knownPaths: []
    }),
    {
      key: 'openclaw',
      displayName: 'OpenClaw',
      mcpCapability: MCP_CAPABILITIES.NATIVE_VERIFIED,
      registrationMode: REGISTRATION_MODES.OFFICIAL_CLI,
      executable: 'openclaw',
      managedEnvKeys: [
        'ERIC_TASK_MASTER_CLIENT_ID',
        'ERIC_TASK_MASTER_CLIENT_NAME',
        'TASKMASTER_CLIENT_ID',
        'TASKMASTER_CLIENT_NAME',
        'ERIC_TASK_MASTER_RUNTIME_VERSION'
      ],
      knownPaths: []
    },
    pendingHost({
      key: 'dsh',
      displayName: 'DeepSeek Harness',
      mcpCapability: MCP_CAPABILITIES.FIRST_PARTY_EXTENSION,
      executable: 'dsh',
      detectionPaths: [resolve(env.DSH_HOME || join(home, '.dsh'))],
      reason: 'DeepSeek Harness uses its first-party MCP client through a version-matched Cordis profile overlay; automatic additive-patch registration is not yet verified.',
      knownPaths: []
    }),
    {
      key: 'pi',
      displayName: 'Pi Coding Agent',
      mcpCapability: MCP_CAPABILITIES.EXTENSION_REQUIRED,
      registrationMode: REGISTRATION_MODES.EXTENSION_REQUIRED,
      executable: 'pi',
      detectionPaths: [resolve(env.PI_HOME || join(home, '.pi'))],
      reason: 'Pi intentionally keeps MCP out of core; install a reviewed MCP extension before registration.',
      knownPaths: []
    },
    pendingHost({
      key: 'vscode-copilot',
      displayName: 'VS Code / GitHub Copilot',
      mcpCapability: MCP_CAPABILITIES.NATIVE_VERIFIED,
      executable: 'code',
      reason: 'MCP is native, but Task Master does not write a user-profile location until that profile path is resolved by the host itself.',
      knownPaths: platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app']
        : platform === 'win32'
          ? [join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe')]
          : []
    }),
    pendingHost({
      key: 'opencode',
      displayName: 'OpenCode',
      mcpCapability: MCP_CAPABILITIES.NATIVE_VERIFIED,
      executable: 'opencode',
      detectionPaths: [join(xdgConfigHome, 'opencode')],
      reason: 'MCP is native, but a version-verified registration and removal contract is not enabled.',
      knownPaths: []
    })
  ];
  return definitions.map((definition) => ({
    ...definition,
    async detect() {
      return detectedBy({ ...definition, env, platform });
    }
  }));
}

export const DEFAULT_HOST_KEYS = Object.freeze([
  'codex',
  'claude-desktop',
  'claude-code',
  'workbuddy',
  'codebuddy-cli',
  'hermes',
  'gemini-cli',
  'openclaw',
  'dsh',
  'pi',
  'vscode-copilot',
  'opencode'
]);
