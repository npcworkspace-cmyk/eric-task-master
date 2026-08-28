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

export function desiredEntry(host, installationId, executablePath, entrypoint, runtimeVersion = null) {
  const clientId = `${installationId}:${host.key}`;
  const clientName = `Eric Task Master / ${host.displayName}`;
  const env = {
    ...(host.entryEnvDefaults || {}),
    ERIC_TASK_MASTER_CLIENT_ID: clientId,
    ERIC_TASK_MASTER_CLIENT_NAME: clientName,
    TASKMASTER_CLIENT_ID: clientId,
    TASKMASTER_CLIENT_NAME: clientName,
    ...(runtimeVersion ? { ERIC_TASK_MASTER_RUNTIME_VERSION: runtimeVersion } : {})
  };
  return {
    ...(host.entryDefaults || {}),
    ...(host.includeType === false ? {} : { type: 'stdio' }),
    command: executablePath,
    args: [entrypoint],
    env
  };
}

function parseJsonValue(source, { allowComments = false, allowTrailingCommas = false } = {}) {
  let index = source.charCodeAt(0) === 0xFEFF ? 1 : 0;

  function invalid() {
    throw new SyntaxError('invalid host configuration');
  }

  function skipTrivia() {
    while (index < source.length) {
      const character = source[index];
      if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
        index += 1;
        continue;
      }
      if (!allowComments || character !== '/') return;
      if (source[index + 1] === '/') {
        index += 2;
        while (index < source.length && source[index] !== '\r' && source[index] !== '\n') index += 1;
        continue;
      }
      if (source[index + 1] === '*') {
        const end = source.indexOf('*/', index + 2);
        if (end === -1) invalid();
        index = end + 2;
        continue;
      }
      return;
    }
  }

  function parseString() {
    const start = index;
    if (source[index] !== '"') invalid();
    index += 1;
    while (index < source.length) {
      if (source[index] === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          invalid();
        }
      }
      if (source[index] === '\\') index += 1;
      index += 1;
    }
    invalid();
  }

  function parseObject() {
    const value = Object.create(null);
    const keys = new Set();
    index += 1;
    skipTrivia();
    if (source[index] === '}') {
      index += 1;
      return value;
    }
    while (index < source.length) {
      const key = parseString();
      if (keys.has(key)) invalid();
      keys.add(key);
      skipTrivia();
      if (source[index] !== ':') invalid();
      index += 1;
      value[key] = parseValue();
      skipTrivia();
      if (source[index] === '}') {
        index += 1;
        return value;
      }
      if (source[index] !== ',') invalid();
      index += 1;
      skipTrivia();
      if (source[index] === '}') {
        if (!allowTrailingCommas) invalid();
        index += 1;
        return value;
      }
    }
    invalid();
  }

  function parseArray() {
    const value = [];
    index += 1;
    skipTrivia();
    if (source[index] === ']') {
      index += 1;
      return value;
    }
    while (index < source.length) {
      value.push(parseValue());
      skipTrivia();
      if (source[index] === ']') {
        index += 1;
        return value;
      }
      if (source[index] !== ',') invalid();
      index += 1;
      skipTrivia();
      if (source[index] === ']') {
        if (!allowTrailingCommas) invalid();
        index += 1;
        return value;
      }
    }
    invalid();
  }

  function parseValue() {
    skipTrivia();
    const character = source[index];
    if (character === '{') return parseObject();
    if (character === '[') return parseArray();
    if (character === '"') return parseString();
    for (const [token, value] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(token, index)) {
        index += token.length;
        return value;
      }
    }
    const number = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!number) invalid();
    index += number.length;
    const numericValue = Number(number);
    if (!Number.isFinite(numericValue)) invalid();
    return numericValue;
  }

  const value = parseValue();
  skipTrivia();
  if (index !== source.length) invalid();
  return value;
}

function parseJsonDocument(source, filePath, options = {}) {
  if (!source.trim()) return {};
  let parsed;
  try {
    parsed = parseJsonValue(source, options);
  } catch {
    // Parser errors never include source text or semantic keys. Host
    // configuration can contain credentials, so expose only a fixed message.
    const format = options.allowComments ? 'JSONC' : 'JSON';
    throw Object.assign(new Error(`Could not safely merge ${filePath}: file is not valid ${format}`), {
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
  const ids = [
    entry?.env?.TASKMASTER_CLIENT_ID,
    entry?.env?.ERIC_TASK_MASTER_CLIENT_ID
  ].filter((value) => typeof value === 'string');
  return ids.length > 0 && ids.every((value) => value === clientId);
}

function managedJsonEntry(entry, context) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const keys = context.managedEntryKeys || Object.keys(context.desired);
  return Object.fromEntries(keys.filter((key) => entry[key] !== undefined).map((key) => {
    if (key !== 'env' || !context.managedEnvKeys) return [key, entry[key]];
    const source = entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env) ? entry.env : {};
    return ['env', Object.fromEntries(context.managedEnvKeys
      .filter((envKey) => source[envKey] !== undefined)
      .map((envKey) => [envKey, source[envKey]]))];
  }));
}

function jsonAdapter(options = {}) {
  return {
    inspect(source, context) {
      const { filePath, desired, clientId } = context;
      const parsed = parseJsonDocument(source, filePath, options);
      const current = parsed.mcpServers?.[SERVER_NAME];
      if (current === undefined) return { state: 'absent' };
      const currentEntry = managedJsonEntry(current, context);
      const currentFingerprint = fingerprint(currentEntry);
      if (fingerprint(managedJsonEntry(desired, context)) === currentFingerprint) {
        return { state: 'registered', currentFingerprint, currentEntry };
      }
      if (ownsJsonEntry(current, clientId)) {
        return { state: 'owned_outdated', currentFingerprint, currentEntry };
      }
      return { state: 'conflict', currentFingerprint };
    },
    install(source, context) {
      const parsed = parseJsonDocument(source, context.filePath, options);
      const inspection = this.inspect(source, context);
      if (inspection.state === 'conflict') throw conflict(context.filePath);
      parsed.mcpServers ||= {};
      const current = parsed.mcpServers[SERVER_NAME];
      parsed.mcpServers[SERVER_NAME] = current && ownsJsonEntry(current, context.clientId)
        ? updateOwnedJsonEntry(current, context)
        : context.desired;
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
    remove(source, context) {
      const parsed = parseJsonDocument(source, context.filePath, options);
      const current = parsed.mcpServers?.[SERVER_NAME];
      if (current === undefined) return source;
      if (!ownsJsonEntry(current, context.clientId)) throw conflict(context.filePath);
      delete parsed.mcpServers[SERVER_NAME];
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
    entryFingerprint(source, context) {
      const parsed = parseJsonDocument(source, context.filePath, options);
      const current = parsed.mcpServers?.[SERVER_NAME];
      return current === undefined ? null : fingerprint(managedJsonEntry(current, context));
    }
  };
}

function updateOwnedJsonEntry(current, context) {
  if (!context.managedEntryKeys) {
    return {
      ...current,
      ...context.desired,
      env: { ...(current.env || {}), ...(context.desired.env || {}) }
    };
  }
  const updated = { ...current };
  for (const key of context.managedEntryKeys) {
    if (key !== 'env' || !context.managedEnvKeys) {
      if (context.desired[key] !== undefined) updated[key] = context.desired[key];
      continue;
    }
    const currentEnv = current.env && typeof current.env === 'object' && !Array.isArray(current.env)
      ? current.env
      : {};
    const desiredEnv = context.desired.env && typeof context.desired.env === 'object'
      ? context.desired.env
      : {};
    updated.env = { ...currentEnv };
    for (const envKey of context.managedEnvKeys) {
      if (desiredEnv[envKey] !== undefined) updated.env[envKey] = desiredEnv[envKey];
    }
  }
  return updated;
}

function escapeToml(value) {
  return JSON.stringify(value);
}

function tomlBlock(context) {
  const { command, args, env } = context.desired;
  const envKeys = [
    'ERIC_TASK_MASTER_CLIENT_ID',
    'ERIC_TASK_MASTER_CLIENT_NAME',
    'TASKMASTER_CLIENT_ID',
    'TASKMASTER_CLIENT_NAME',
    'ERIC_TASK_MASTER_RUNTIME_VERSION'
  ].filter((key) => env[key] !== undefined);
  return [
    `# eric-task-master registration ${env.TASKMASTER_CLIENT_ID}`,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${escapeToml(command)}`,
    `args = [${args.map(escapeToml).join(', ')}]`,
    `env = { ${envKeys.map((key) => `${key} = ${escapeToml(env[key])}`).join(', ')} }`,
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
  const runtimeVersionLine = env.ERIC_TASK_MASTER_RUNTIME_VERSION === undefined
    ? []
    : [`      ERIC_TASK_MASTER_RUNTIME_VERSION: ${JSON.stringify(env.ERIC_TASK_MASTER_RUNTIME_VERSION)}`];
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
    ...runtimeVersionLine,
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
const JSONC_ADAPTER = jsonAdapter({ allowComments: true, allowTrailingCommas: true });
const TOML_ADAPTER = textAdapter('toml');
const YAML_ADAPTER = textAdapter('yaml');

export function adapterFor(format) {
  if (format === 'json') return JSON_ADAPTER;
  if (format === 'jsonc') return JSONC_ADAPTER;
  if (format === 'toml') return TOML_ADAPTER;
  if (format === 'yaml') return YAML_ADAPTER;
  throw new Error(`Unknown host config format: ${format}`);
}
