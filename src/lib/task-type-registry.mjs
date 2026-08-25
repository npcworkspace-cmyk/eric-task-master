import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './json-store.mjs';

const MAX_TASK_MODULE_BYTES = 2 * 1024 * 1024;
const MAX_INSPECTOR_RESULT_BYTES = 96 * 1024;
const DEFAULT_INSPECTION_TIMEOUT_MS = 5_000;
const INSPECTOR_PATH = fileURLToPath(new URL('../runtime/task-module-inspector.mjs', import.meta.url));
const TASK_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;
const INPUT_SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
const TASK_RISKS = new Set(['read', 'write', 'mixed']);
const DISCOVERY_TOKEN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const INPUT_SCHEMA_KEYS = new Set([
  'additionalProperties',
  'default',
  'description',
  'enum',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'pattern',
  'properties',
  'required',
  'title',
  'type'
]);

export class TaskTypeRegistryError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'TaskTypeRegistryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function publicType(record, { includeSchema = true, includeIntegrity = true } = {}) {
  return {
    id: record.name,
    name: record.name,
    title: record.title || record.name,
    ...(record.description ? { description: record.description } : {}),
    ...(record.version ? { version: record.version } : {}),
    ...(includeSchema && record.inputSchema ? { inputSchema: structuredClone(record.inputSchema) } : {}),
    readOnly: record.readOnly === true,
    ...(record.domains?.length ? { domains: [...record.domains] } : {}),
    ...(record.intents?.length ? { intents: [...record.intents] } : {}),
    ...(record.tags?.length ? { tags: [...record.tags] } : {}),
    ...(record.outputs?.length ? { outputs: [...record.outputs] } : {}),
    ...(record.risk ? { risk: record.risk } : {}),
    ...(record.pack ? { pack: { name: record.pack.name, version: record.pack.version } } : {}),
    supportsResume: record.supportsResume === true,
    ...(includeIntegrity ? {
      sha256: record.sha256,
      size: record.size,
      installedAt: record.installedAt
    } : {})
  };
}

function boundedTokenList(value, field, maximum = 32) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) || value.length > maximum ||
    value.some((item) => typeof item !== 'string' || !DISCOVERY_TOKEN.test(item)) ||
    new Set(value).size !== value.length
  ) {
    throw new TaskTypeRegistryError(
      'INVALID_TASK_METADATA',
      `meta.${field} must contain at most ${maximum} unique lowercase discovery tokens`
    );
  }
  return value.length ? [...value] : undefined;
}

function boundedDomains(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16 || new Set(value).size !== value.length) {
    throw new TaskTypeRegistryError(
      'INVALID_TASK_METADATA',
      'meta.domains must contain at most 16 unique hostnames'
    );
  }
  const normalized = value.map((item) => String(item).trim().toLowerCase());
  for (const domain of normalized) {
    const host = domain.startsWith('*.') ? domain.slice(2) : domain;
    if (!host || host.length > 253 || /[^a-z0-9.-]/u.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
      throw new TaskTypeRegistryError(
        'INVALID_TASK_METADATA',
        'meta.domains must contain simple hostnames or wildcard subdomains'
      );
    }
  }
  return normalized.length ? normalized : undefined;
}

function invalidSchema(location, message) {
  throw new TaskTypeRegistryError(
    'INVALID_TASK_METADATA',
    `meta.inputSchema ${location} ${message}`
  );
}

function validateInputSchema(schema, location = '$', depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    invalidSchema(location, 'must be an object');
  }
  if (depth > 20) invalidSchema(location, 'is nested too deeply');
  const unknown = Object.keys(schema).find((key) => !INPUT_SCHEMA_KEYS.has(key));
  if (unknown) invalidSchema(location, `uses unsupported keyword ${unknown}`);

  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (types.some((type) => typeof type !== 'string' || !INPUT_SCHEMA_TYPES.has(type)) || new Set(types).size !== types.length) {
    invalidSchema(`${location}.type`, 'contains an unsupported or duplicate type');
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 1_000)) {
    invalidSchema(`${location}.enum`, 'must contain 1 to 1000 JSON values');
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) {
      invalidSchema(`${location}.${key}`, 'must be a non-negative integer');
    }
  }
  if (schema.minLength > schema.maxLength) invalidSchema(location, 'has minLength greater than maxLength');
  if (schema.minItems > schema.maxItems) invalidSchema(location, 'has minItems greater than maxItems');
  for (const key of ['minimum', 'maximum']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) {
      invalidSchema(`${location}.${key}`, 'must be a finite number');
    }
  }
  if (schema.minimum > schema.maximum) invalidSchema(location, 'has minimum greater than maximum');
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string' || schema.pattern.length > 2_000) {
      invalidSchema(`${location}.pattern`, 'must be a string of at most 2000 characters');
    }
    try {
      new RegExp(schema.pattern, 'u');
    } catch {
      invalidSchema(`${location}.pattern`, 'must be a valid Unicode regular expression');
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string') || new Set(schema.required).size !== schema.required.length) {
      invalidSchema(`${location}.required`, 'must contain unique string property names');
    }
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      invalidSchema(`${location}.properties`, 'must be an object');
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      validateInputSchema(child, `${location}.properties.${key}`, depth + 1);
    }
  }
  if (schema.items !== undefined) validateInputSchema(schema.items, `${location}.items`, depth + 1);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    validateInputSchema(schema.additionalProperties, `${location}.additionalProperties`, depth + 1);
  }
}

function safeMetadata(meta, expectedName) {
  const source = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const title = typeof source.title === 'string' && source.title.trim()
    ? source.title.trim().slice(0, 120)
    : typeof source.name === 'string' && source.name.trim()
      ? source.name.trim().slice(0, 120)
      : expectedName;
  const description = typeof source.description === 'string' && source.description.trim()
    ? source.description.trim().slice(0, 2_000)
    : undefined;
  const version = ['string', 'number'].includes(typeof source.version)
    ? String(source.version).slice(0, 32)
    : undefined;
  let inputSchema;
  if (source.inputSchema !== undefined) {
    if (!source.inputSchema || typeof source.inputSchema !== 'object' || Array.isArray(source.inputSchema)) {
      throw new TaskTypeRegistryError('INVALID_TASK_METADATA', 'meta.inputSchema must be an object');
    }
    const encoded = JSON.stringify(source.inputSchema);
    if (Buffer.byteLength(encoded) > 64 * 1024) {
      throw new TaskTypeRegistryError('INVALID_TASK_METADATA', 'meta.inputSchema exceeds 64 KiB');
    }
    inputSchema = JSON.parse(encoded);
    validateInputSchema(inputSchema);
  }
  const domains = boundedDomains(source.domains);
  const intents = boundedTokenList(source.intents, 'intents', 16);
  const tags = boundedTokenList(source.tags, 'tags');
  const outputs = boundedTokenList(source.outputs, 'outputs');
  if (source.preferredBehavior !== undefined) {
    throw new TaskTypeRegistryError(
      'TASK_BEHAVIOR_PROFILE_OWNED',
      'Task behavior belongs to the selected Profile; remove meta.preferredBehavior'
    );
  }
  if (source.risk !== undefined && !TASK_RISKS.has(source.risk)) {
    throw new TaskTypeRegistryError('INVALID_TASK_METADATA', 'meta.risk must be read, write, or mixed');
  }
  if (source.supportsResume !== undefined && typeof source.supportsResume !== 'boolean') {
    throw new TaskTypeRegistryError('INVALID_TASK_METADATA', 'meta.supportsResume must be a boolean');
  }
  return {
    title,
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    ...(inputSchema ? { inputSchema } : {}),
    readOnly: source.readOnly === true,
    ...(domains ? { domains } : {}),
    ...(intents ? { intents } : {}),
    ...(tags ? { tags } : {}),
    ...(outputs ? { outputs } : {}),
    ...(source.risk ? { risk: source.risk } : {}),
    supportsResume: source.supportsResume === true
  };
}

function decodeInspectorResult(message, nonce, expectedName) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (message.type !== 'task-module-inspection' || message.nonce !== nonce) return null;
  const keys = Object.keys(message).sort();
  if (message.ok === false) {
    if (
      keys.join(',') !== 'nonce,ok,reason,type'
      || !['contract', 'load', 'metadata', 'metadata-size'].includes(message.reason)
    ) {
      throw new TaskTypeRegistryError('INVALID_TASK_MODULE', 'Task module inspection returned an invalid result');
    }
    if (message.reason === 'metadata' || message.reason === 'metadata-size') {
      throw new TaskTypeRegistryError('INVALID_TASK_METADATA', 'Task module metadata is not valid bounded JSON');
    }
    throw new TaskTypeRegistryError(
      'INVALID_TASK_MODULE',
      message.reason === 'contract'
        ? 'Task module must export async function run(runtime)'
        : 'Task module could not be loaded'
    );
  }
  if (message.ok !== true || keys.join(',') !== 'metadataJson,nonce,ok,type') {
    throw new TaskTypeRegistryError('INVALID_TASK_MODULE', 'Task module inspection returned an invalid result');
  }
  if (typeof message.metadataJson !== 'string' || Buffer.byteLength(message.metadataJson) > MAX_INSPECTOR_RESULT_BYTES) {
    throw new TaskTypeRegistryError('INVALID_TASK_METADATA', 'Task module metadata exceeds the inspection limit');
  }
  let meta;
  try {
    meta = JSON.parse(message.metadataJson);
  } catch {
    throw new TaskTypeRegistryError('INVALID_TASK_METADATA', 'Task module metadata is not valid JSON');
  }
  return safeMetadata(meta, expectedName);
}

async function inspectTaskModule(snapshotPath, sha256, expectedName, timeoutMs) {
  const nonce = randomBytes(16).toString('hex');
  let child;
  try {
    child = fork(INSPECTOR_PATH, [], {
      execArgv: [],
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    });
  } catch {
    throw new TaskTypeRegistryError('INVALID_TASK_MODULE', 'Task module inspector could not be started', 500);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.connected) child.disconnect();
      } catch {}
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new TaskTypeRegistryError(
        'TASK_MODULE_INSPECTION_TIMEOUT',
        `Task module inspection exceeded ${timeoutMs} ms`
      ));
    }, timeoutMs);

    child.once('error', () => {
      finish(new TaskTypeRegistryError('INVALID_TASK_MODULE', 'Task module inspector could not be started', 500));
    });
    child.once('exit', () => {
      finish(new TaskTypeRegistryError('INVALID_TASK_MODULE', 'Task module exited before inspection completed'));
    });
    child.on('message', (message) => {
      let metadata;
      try {
        metadata = decodeInspectorResult(message, nonce, expectedName);
      } catch (error) {
        finish(error);
        return;
      }
      if (metadata) finish(null, metadata);
    });
    try {
      child.send({ type: 'inspect-task-module', nonce, snapshotPath, sha256 }, (error) => {
        if (error) {
          finish(new TaskTypeRegistryError('INVALID_TASK_MODULE', 'Task module inspector could not receive the request', 500));
        }
      });
    } catch {
      finish(new TaskTypeRegistryError('INVALID_TASK_MODULE', 'Task module inspector could not receive the request', 500));
    }
  });
}

async function verifySnapshot(snapshotPath, sha256) {
  const stats = await lstat(snapshotPath).catch(() => null);
  const source = stats?.isFile() && !stats.isSymbolicLink()
    ? await readFile(snapshotPath)
    : null;
  if (!source || createHash('sha256').update(source).digest('hex') !== sha256) {
    throw new TaskTypeRegistryError('TASK_SNAPSHOT_CHANGED', 'Task snapshot integrity check failed', 500);
  }
  return source;
}

export class TaskTypeRegistry {
  #store;
  #snapshotRoot;
  #allowedRoots;
  #seedTypes;
  #inspectionTimeoutMs;
  #ready;

  constructor({
    filePath,
    snapshotRoot,
    allowedRoots = [],
    seedTypes = [],
    inspectionTimeoutMs = DEFAULT_INSPECTION_TIMEOUT_MS
  }) {
    if (!filePath || !snapshotRoot) throw new TypeError('Task type registry paths are required');
    if (!Number.isInteger(inspectionTimeoutMs) || inspectionTimeoutMs < 100 || inspectionTimeoutMs > 30_000) {
      throw new TypeError('inspectionTimeoutMs must be an integer from 100 to 30000');
    }
    this.#store = new JsonStore(filePath, { version: 1, types: [] });
    this.#snapshotRoot = path.resolve(snapshotRoot);
    this.#allowedRoots = allowedRoots.map((root) => path.resolve(root));
    this.#seedTypes = seedTypes;
    this.#inspectionTimeoutMs = inspectionTimeoutMs;
    this.#ready = this.#initialize();
  }

  async #initialize() {
    await mkdir(this.#snapshotRoot, { recursive: true, mode: 0o700 });
    await this.#store.init();
    const canonicalRoots = [];
    for (const root of this.#allowedRoots) {
      try {
        canonicalRoots.push(await realpath(root));
      } catch {
        throw new TaskTypeRegistryError(
          'TASK_ROOT_NOT_FOUND',
          'A configured task root does not exist',
          500
        );
      }
    }
    this.#allowedRoots = [...new Set(canonicalRoots)];
    for (const seed of this.#seedTypes) {
      await this.#install(seed, { allowUpdate: true });
    }
  }

  async install(input = {}) {
    await this.#ready;
    return this.#install(input);
  }

  async installBatch(inputs = [], { pack } = {}) {
    await this.#ready;
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 64) {
      throw new TaskTypeRegistryError('INVALID_TASK_PACK', 'Task Pack must contain 1 to 64 task modules');
    }
    const names = inputs.map((input) => input?.name);
    if (new Set(names).size !== names.length) {
      throw new TaskTypeRegistryError('INVALID_TASK_PACK', 'Task Pack task names must be unique');
    }
    const snapshot = await this.#store.read();
    const prepared = [];
    for (const input of inputs) {
      const candidate = await this.#prepareInstall(input, { currentTypes: snapshot.types });
      if (candidate.changed && pack) {
        candidate.record.pack = { name: pack.name, version: pack.version };
      }
      prepared.push(candidate);
    }

    const installed = [];
    await this.#store.update((data) => {
      // Validate the entire batch against the latest registry before changing
      // any record. A conflict therefore cannot leave a partially installed Pack.
      for (const candidate of prepared) {
        const current = data.types.find((item) => item.name === candidate.record.name);
        if (current && current.sha256 !== candidate.record.sha256) {
          throw new TaskTypeRegistryError(
            'TASK_TYPE_CONFLICT',
            `Task type ${candidate.record.name} is already installed with different content`,
            409
          );
        }
      }
      for (const candidate of prepared) {
        const current = data.types.find((item) => item.name === candidate.record.name);
        if (current) installed.push(current);
        else {
          data.types.push(candidate.record);
          installed.push(candidate.record);
        }
      }
    });
    return installed.map((record) => publicType(record));
  }

  async #prepareInstall({ name, modulePath } = {}, { allowUpdate = false, currentTypes = [] } = {}) {
    if (typeof name !== 'string' || !TASK_TYPE_PATTERN.test(name)) {
      throw new TaskTypeRegistryError(
        'INVALID_TASK_TYPE',
        'Task type must use 1-80 lowercase letters, numbers, dots, underscores, or hyphens'
      );
    }
    if (typeof modulePath !== 'string' || !modulePath || path.extname(modulePath).toLowerCase() !== '.mjs') {
      throw new TaskTypeRegistryError('INVALID_TASK_MODULE', 'Task module must be a .mjs file');
    }

    const requested = path.resolve(modulePath);
    const linkStats = await lstat(requested).catch(() => null);
    if (!linkStats?.isFile() || linkStats.isSymbolicLink()) {
      throw new TaskTypeRegistryError('INVALID_TASK_MODULE', 'Task module must be a regular file', 400);
    }
    const canonical = await realpath(requested);
    if (!this.#allowedRoots.some((root) => inside(root, canonical))) {
      throw new TaskTypeRegistryError(
        'TASK_MODULE_OUTSIDE_ALLOWED_ROOTS',
        'Task module is outside the configured task roots',
        403
      );
    }
    const source = await readFile(canonical);
    if (source.length === 0 || source.length > MAX_TASK_MODULE_BYTES) {
      throw new TaskTypeRegistryError(
        'INVALID_TASK_MODULE_SIZE',
        `Task module must contain 1 to ${MAX_TASK_MODULE_BYTES} bytes`
      );
    }
    if (await realpath(requested) !== canonical) {
      throw new TaskTypeRegistryError('TASK_MODULE_CHANGED', 'Task module changed during installation', 409);
    }

    const sha256 = createHash('sha256').update(source).digest('hex');
    const snapshotName = `${name}-${sha256}.mjs`;
    const snapshotPath = path.join(this.#snapshotRoot, snapshotName);
    const current = currentTypes.find((item) => item.name === name);
    if (current?.sha256 === sha256) {
      if (current.snapshotName !== snapshotName) {
        throw new TaskTypeRegistryError('INVALID_TASK_SNAPSHOT', 'Task snapshot path is invalid', 500);
      }
      await verifySnapshot(snapshotPath, sha256);
      return { record: current, changed: false };
    }
    if (current && !allowUpdate) {
      throw new TaskTypeRegistryError(
        'TASK_TYPE_CONFLICT',
        `Task type ${name} is already installed with different content`,
        409
      );
    }
    await writeFile(snapshotPath, source, { flag: 'wx', mode: 0o600 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    await verifySnapshot(snapshotPath, sha256);
    const metadata = await inspectTaskModule(
      snapshotPath,
      sha256,
      name,
      this.#inspectionTimeoutMs
    );
    await verifySnapshot(snapshotPath, sha256);
    const record = {
      name,
      ...metadata,
      sha256,
      size: source.length,
      snapshotName,
      installedAt: new Date().toISOString()
    };
    return { record, changed: true };
  }

  async #install(input, { allowUpdate = false } = {}) {
    const snapshot = await this.#store.read();
    const prepared = await this.#prepareInstall(input, { allowUpdate, currentTypes: snapshot.types });
    if (!prepared.changed) return publicType(prepared.record);
    let installed;
    await this.#store.update((data) => {
      const { record } = prepared;
      const { name, sha256 } = record;
      const index = data.types.findIndex((item) => item.name === name);
      if (index >= 0 && data.types[index].sha256 === sha256) {
        installed = data.types[index];
        return;
      }
      if (index >= 0 && !allowUpdate) {
        throw new TaskTypeRegistryError(
          'TASK_TYPE_CONFLICT',
          `Task type ${name} is already installed with different content`,
          409
        );
      }
      if (index >= 0) data.types[index] = record;
      else data.types.push(record);
      installed = record;
    });
    return publicType(installed);
  }

  async list() {
    await this.#ready;
    const data = await this.#store.read();
    return data.types
      .map(publicType)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async listSummaries() {
    await this.#ready;
    const data = await this.#store.read();
    return data.types
      .map((record) => publicType(record, { includeSchema: false, includeIntegrity: false }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async describe(name) {
    await this.#ready;
    const data = await this.#store.read();
    const record = data.types.find((item) => item.name === name);
    if (!record) {
      throw new TaskTypeRegistryError('TASK_TYPE_NOT_FOUND', `Task type ${name} was not found`, 404);
    }
    return publicType(record, { includeSchema: true, includeIntegrity: false });
  }

  async resolve(name) {
    await this.#ready;
    const data = await this.#store.read();
    const record = data.types.find((item) => item.name === name);
    if (!record) {
      throw new TaskTypeRegistryError('TASK_TYPE_NOT_FOUND', `Task type ${name} was not found`, 404);
    }
    const candidate = path.resolve(this.#snapshotRoot, record.snapshotName);
    if (!inside(this.#snapshotRoot, candidate)) {
      throw new TaskTypeRegistryError('INVALID_TASK_SNAPSHOT', 'Task snapshot path is invalid', 500);
    }
    const stats = await lstat(candidate).catch(() => null);
    if (!stats?.isFile() || stats.isSymbolicLink()) {
      throw new TaskTypeRegistryError('TASK_SNAPSHOT_MISSING', 'Task snapshot is unavailable', 500);
    }
    const source = await readFile(candidate);
    const sha256 = createHash('sha256').update(source).digest('hex');
    if (sha256 !== record.sha256) {
      throw new TaskTypeRegistryError('TASK_SNAPSHOT_CHANGED', 'Task snapshot integrity check failed', 500);
    }
    return { ...publicType(record), modulePath: candidate };
  }
}
