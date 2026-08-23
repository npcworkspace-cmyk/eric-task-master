import { join, resolve } from 'node:path';
import { pathExists } from './files.mjs';

function executableCandidates(name, env, platform) {
  const pathEntries = String(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  return pathEntries.flatMap((directory) => extensions.map((extension) => join(directory, `${name}${extension.toLowerCase()}`)));
}

async function detectedBy({ configPath, executable, knownPaths = [], env, platform }) {
  const candidates = [configPath, ...knownPaths];
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

export function createHostDefinitions({ home, env, platform }) {
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const codexHome = resolve(env.CODEX_HOME || join(home, '.codex'));
  const claudeConfig = env.CLAUDE_CONFIG_DIR
    ? join(resolve(env.CLAUDE_CONFIG_DIR), '.claude.json')
    : join(home, '.claude.json');
  const workBuddyHome = resolve(env.WORKBUDDY_HOME || join(home, '.workbuddy'));
  const hermesHome = resolve(env.HERMES_HOME || join(home, '.hermes'));
  const definitions = [
    {
      key: 'codex',
      displayName: 'Codex',
      support: 'native',
      format: 'toml',
      configPath: resolve(env.TASKMASTER_CODEX_CONFIG || join(codexHome, 'config.toml')),
      executable: 'codex',
      knownPaths: platform === 'darwin'
        ? ['/Applications/Codex.app']
        : platform === 'win32' ? [join(localAppData, 'Microsoft', 'WindowsApps', 'codex.exe')] : []
    },
    {
      key: 'claude-desktop',
      displayName: 'Claude Desktop',
      support: 'native',
      format: 'json',
      configPath: desktopConfig(home, env, platform),
      executable: null,
      knownPaths: platform === 'darwin'
        ? ['/Applications/Claude.app']
        : platform === 'win32'
          ? [join(localAppData, 'Programs', 'Claude', 'Claude.exe'), join(localAppData, 'AnthropicClaude', 'Claude.exe')]
          : []
    },
    {
      key: 'claude-code',
      displayName: 'Claude Code',
      support: 'native',
      format: 'json',
      configPath: resolve(env.TASKMASTER_CLAUDE_CODE_CONFIG || claudeConfig),
      executable: 'claude',
      knownPaths: []
    },
    {
      key: 'workbuddy',
      displayName: 'WorkBuddy',
      support: 'needs_adapter',
      format: 'json',
      configPath: resolve(env.WORKBUDDY_MCP_CONFIG || join(workBuddyHome, '.mcp.json')),
      executable: 'workbuddy',
      knownPaths: platform === 'darwin'
        ? ['/Applications/WorkBuddy.app']
        : platform === 'win32' ? [join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')] : []
    },
    {
      key: 'hermes',
      displayName: 'Hermes Agent',
      support: 'native',
      format: 'yaml',
      configPath: resolve(env.TASKMASTER_HERMES_CONFIG || join(hermesHome, 'config.yaml')),
      executable: 'hermes',
      knownPaths: []
    },
    {
      key: 'dsh',
      displayName: 'DeepSeek Harness',
      support: 'needs_adapter',
      executable: 'dsh',
      configPath: resolve(env.DSH_HOME || join(home, '.dsh')),
      knownPaths: []
    },
    {
      key: 'pi',
      displayName: 'Pi Coding Agent',
      support: 'needs_adapter',
      executable: 'pi',
      configPath: resolve(env.PI_HOME || join(home, '.pi')),
      knownPaths: []
    },
    {
      key: 'openclaw',
      displayName: 'OpenClaw',
      support: 'needs_adapter',
      executable: 'openclaw',
      configPath: resolve(env.OPENCLAW_HOME || join(home, '.openclaw')),
      knownPaths: []
    }
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
  'hermes',
  'dsh',
  'pi',
  'openclaw'
]);
