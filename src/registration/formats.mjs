import { sha256 } from './files.mjs';

export const SERVER_NAME = 'eric-task-master';

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

export function fingerprint(value) {
  return sha256(Buffer.from(JSON.stringify(sorted(value)), 'utf8'));
}

export function desiredEntry(host, installationId, executablePath, entrypoint) {
  const clientId = `${installationId}:${host.key}`;
  const clientName = `Eric Task Master / ${host.displayName}`;
  const env = {
    ERIC_TASK_MASTER_CLIENT_ID: clientId,
    ERIC_TASK_MASTER_CLIENT_NAME: clientName,
    TASKMASTER_CLIENT_ID: clientId,
    TASKMASTER_CLIENT_NAME: clientName
  };
  return {
    type: 'stdio',
    command: executablePath,
    args: [entrypoint],
    env
  };
}

function parseJsonDocument(source, filePath) {
  if (!source.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw Object.assign(new Error(`Could not safely merge ${filePath}: ${error.message}`), {
      code: 'INVALID_HOST_CONFIG'
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error(`${filePath} must contain a JSON object`), {
      code: 'INVALID_HOST_CONFIG'
    });
  }
  if (parsed.mcpServers !== undefined && (
    !parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)
  )) {
    throw Object.assign(new Error(`${filePath} mcpServers must be an object`), {
      code: 'INVALID_HOST_CONFIG'
    });
  }
  return parsed;
}

function ownsJsonEntry(entry, clientId) {
  return entry?.env?.TASKMASTER_CLIENT_ID === clientId;
}

function jsonAdapter() {
  return {
    inspect(source, { filePath, desired, clientId }) {
      const parsed = parseJsonDocument(source, filePath);
      const current = parsed.mcpServers?.[SERVER_NAME];
      if (current === undefined) return { state: 'absent' };
      const currentFingerprint = fingerprint(current);
      if (fingerprint(desired) === currentFingerprint) {
        return { state: 'registered', currentFingerprint };
      }
      if (ownsJsonEntry(current, clientId)) {
        return { state: 'owned_outdated', currentFingerprint };
      }
      return { state: 'conflict', currentFingerprint };
    },
    install(source, context) {
      const parsed = parseJsonDocument(source, context.filePath);
      const inspection = this.inspect(source, context);
      if (inspection.state === 'conflict') throw conflict(context.filePath);
      parsed.mcpServers ||= {};
      parsed.mcpServers[SERVER_NAME] = context.desired;
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
    remove(source, context) {
      const parsed = parseJsonDocument(source, context.filePath);
      const current = parsed.mcpServers?.[SERVER_NAME];
      if (current === undefined) return source;
      if (!ownsJsonEntry(current, context.clientId)) throw conflict(context.filePath);
      delete parsed.mcpServers[SERVER_NAME];
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
    entryFingerprint(source, context) {
      const parsed = parseJsonDocument(source, context.filePath);
      const current = parsed.mcpServers?.[SERVER_NAME];
      return current === undefined ? null : fingerprint(current);
    }
  };
}

function escapeToml(value) {
  return JSON.stringify(value);
}

function tomlBlock(context) {
  const { command, args, env } = context.desired;
  return [
    `# eric-task-master registration ${env.TASKMASTER_CLIENT_ID}`,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${escapeToml(command)}`,
    `args = [${args.map(escapeToml).join(', ')}]`,
    `env = { ERIC_TASK_MASTER_CLIENT_ID = ${escapeToml(env.ERIC_TASK_MASTER_CLIENT_ID)}, ERIC_TASK_MASTER_CLIENT_NAME = ${escapeToml(env.ERIC_TASK_MASTER_CLIENT_NAME)}, TASKMASTER_CLIENT_ID = ${escapeToml(env.TASKMASTER_CLIENT_ID)}, TASKMASTER_CLIENT_NAME = ${escapeToml(env.TASKMASTER_CLIENT_NAME)} }`,
    ''
  ].join('\n');
}

function invalidTextConfig(filePath, message) {
  return Object.assign(new Error(`Could not safely merge ${filePath}: ${message}`), {
    code: 'INVALID_HOST_CONFIG'
  });
}

function findTomlBlock(source, filePath = 'TOML host configuration') {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const root = '(?:mcp_servers|"mcp_servers"|\'mcp_servers\')';
  const server = '(?:eric-task-master|"eric-task-master"|\'eric-task-master\')';
  const header = new RegExp(`^\\s*\\[\\s*${root}\\s*\\.\\s*${server}\\s*\\]\\s*(?:#.*)?$`);
  const matches = lines.flatMap((line, index) => header.test(line) ? [index] : []);
  if (matches.length > 1) {
    throw invalidTextConfig(filePath, 'multiple semantic eric-task-master TOML entries');
  }
  const [headerIndex = -1] = matches;
  if (headerIndex === -1) return null;
  let start = headerIndex;
  if (headerIndex > 0 && /^\s*#\s*eric-task-master registration\s+/.test(lines[headerIndex - 1])) {
    start -= 1;
  }
  let end = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index;
      break;
    }
  }
  while (end > start && lines[end - 1] === '') end -= 1;
  return { lines, start, end, text: `${lines.slice(start, end).join('\n')}\n` };
}

function ownsText(block, clientId) {
  return block.includes(`TASKMASTER_CLIENT_ID = ${escapeToml(clientId)}`)
    || block.includes(`TASKMASTER_CLIENT_ID: ${JSON.stringify(clientId)}`);
}

function textAdapter(kind) {
  const find = kind === 'toml' ? findTomlBlock : findYamlBlock;
  const render = kind === 'toml' ? tomlBlock : yamlBlock;
  return {
    inspect(source, context) {
      const current = find(source, context.filePath);
      if (!current) return { state: 'absent' };
      const currentFingerprint = sha256(Buffer.from(current.text, 'utf8'));
      const desiredFingerprint = sha256(Buffer.from(render(context), 'utf8'));
      if (currentFingerprint === desiredFingerprint) {
        return { state: 'registered', currentFingerprint };
      }
      if (ownsText(current.text, context.clientId)) {
        return { state: 'owned_outdated', currentFingerprint };
      }
      return { state: 'conflict', currentFingerprint };
    },
    install(source, context) {
      const current = find(source, context.filePath);
      if (current && !ownsText(current.text, context.clientId)) throw conflict(context.filePath);
      const block = render(context);
      if (!current) return kind === 'toml' ? appendToml(source, block) : appendYaml(source, block);
      const replacement = [...current.lines];
      replacement.splice(current.start, current.end - current.start, ...block.trimEnd().split('\n'));
      return `${replacement.join('\n').replace(/\n+$/, '')}\n`;
    },
    remove(source, context) {
      const current = find(source, context.filePath);
      if (!current) return source;
      if (!ownsText(current.text, context.clientId)) throw conflict(context.filePath);
      const replacement = [...current.lines];
      replacement.splice(current.start, current.end - current.start);
      return `${replacement.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')}${replacement.some((line) => line.trim()) ? '\n' : ''}`;
    },
    entryFingerprint(source, context) {
      const current = find(source, context.filePath);
      return current ? sha256(Buffer.from(current.text, 'utf8')) : null;
    }
  };
}

function appendToml(source, block) {
  const base = source.replace(/\r\n/g, '\n').replace(/\s*$/, '');
  return `${base}${base ? '\n\n' : ''}${block}`;
}

function yamlBlock(context) {
  const { command, args, env } = context.desired;
  return [
    `  ${SERVER_NAME}:`,
    `    command: ${JSON.stringify(command)}`,
    '    args:',
    ...args.map((arg) => `      - ${JSON.stringify(arg)}`),
    '    env:',
    `      ERIC_TASK_MASTER_CLIENT_ID: ${JSON.stringify(env.ERIC_TASK_MASTER_CLIENT_ID)}`,
    `      ERIC_TASK_MASTER_CLIENT_NAME: ${JSON.stringify(env.ERIC_TASK_MASTER_CLIENT_NAME)}`,
    `      TASKMASTER_CLIENT_ID: ${JSON.stringify(env.TASKMASTER_CLIENT_ID)}`,
    `      TASKMASTER_CLIENT_NAME: ${JSON.stringify(env.TASKMASTER_CLIENT_NAME)}`,
    ''
  ].join('\n');
}

function yamlStructure(source, filePath = 'YAML host configuration') {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const root = /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*:\s*([^#]*?)\s*(?:#.*)?$/;
  const roots = lines.flatMap((line, index) => root.test(line) ? [index] : []);
  if (roots.length > 1) {
    throw invalidTextConfig(filePath, 'multiple semantic mcp_servers YAML roots');
  }
  const [rootIndex = -1] = roots;
  if (rootIndex === -1) return { lines, rootIndex, start: -1, end: -1 };
  const rootMatch = root.exec(lines[rootIndex]);
  const rootValue = rootMatch?.[1]?.trim() || '';
  if (rootValue && !/^\{\s*\}$/.test(rootValue)) {
    throw invalidTextConfig(filePath, 'non-empty flow-style mcp_servers YAML cannot be edited safely');
  }
  let rootEnd = lines.length;
  for (let index = rootIndex + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index]) && lines[index].trim() && !/^\s*#/.test(lines[index])) {
      rootEnd = index;
      break;
    }
  }
  const entry = /^ {2}(?:eric-task-master|"eric-task-master"|'eric-task-master')\s*:\s*(?:#.*)?$/;
  const entries = lines.flatMap((line, index) => (
    index > rootIndex && index < rootEnd && entry.test(line) ? [index] : []
  ));
  if (entries.length > 1) {
    throw invalidTextConfig(filePath, 'multiple semantic eric-task-master YAML entries');
  }
  const [start = -1] = entries;
  return { lines, rootIndex, rootValue, rootEnd, start };
}

function findYamlBlock(source, filePath = 'YAML host configuration') {
  const structure = yamlStructure(source, filePath);
  const { lines, start } = structure;
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^(?:\S|  [^\s#])/.test(lines[index]) && lines[index].trim() && !/^\s*#/.test(lines[index])) {
      end = index;
      break;
    }
  }
  while (end > start && lines[end - 1] === '') end -= 1;
  return { lines, start, end, text: `${lines.slice(start, end).join('\n')}\n` };
}

function appendYaml(source, block) {
  const normalized = source.replace(/\r\n/g, '\n');
  const structure = yamlStructure(normalized);
  const { lines, rootIndex } = structure;
  if (rootIndex === -1) {
    const base = normalized.replace(/\s*$/, '');
    return `${base}${base ? '\n\n' : ''}mcp_servers:\n${block}`;
  }
  if (structure.rootValue) lines[rootIndex] = 'mcp_servers:';
  const insertion = structure.rootEnd;
  lines.splice(insertion, 0, ...block.trimEnd().split('\n'));
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function conflict(filePath) {
  return Object.assign(new Error(`${filePath} already contains an unowned ${SERVER_NAME} entry`), {
    code: 'REGISTRATION_CONFLICT'
  });
}

const JSON_ADAPTER = jsonAdapter();
const TOML_ADAPTER = textAdapter('toml');
const YAML_ADAPTER = textAdapter('yaml');

export function adapterFor(format) {
  if (format === 'json') return JSON_ADAPTER;
  if (format === 'toml') return TOML_ADAPTER;
  if (format === 'yaml') return YAML_ADAPTER;
  throw new Error(`Unknown host config format: ${format}`);
}
