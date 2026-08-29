import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './json-store.mjs';
import {
  FULL_HUMAN_INTERACTION_CONTRACT,
  validateFullHumanPackSource
} from './interaction-contract.mjs';

const MAX_TASK_MODULE_BYTES = 2 * 1024 * 1024;
const MAX_INSPECTOR_RESULT_BYTES = 96 * 1024;
const DEFAULT_INSPECTION_TIMEOUT_MS = 5_000;
const INSPECTOR_PATH = fileURLToPath(new URL('../runtime/task-module-inspector.mjs', import.meta.url));
const TASK_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;
const INPUT_SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
const TASK_RISKS = new Set(['read', 'write', 'mixed']);
const DISCOVERY_TOKEN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const PACK_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ASSET_KINDS = new Set(['pack', 'standalone', 'system']);
const MAX_ASSET_NOTE_LENGTH = 1_000;
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

function publicType(record, {
  includeSchema = true,
  includeIntegrity = true,
  includeManagement = false
} = {}) {
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
    ...(record.pack ? {
      pack: {
        name: record.pack.name,
        version: record.pack.version,
        ...(record.pack.title ? { title: record.pack.title } : {}),
        ...(record.pack.description ? { description: record.pack.description } : {})
      }
    } : {}),
    ...(record.interactionContract ? { interactionContract: record.interactionContract } : {}),
    lifecycle: record.deprecatedAt ? 'deprecated' : 'active',
    ...(record.deprecatedAt ? { deprecatedAt: record.deprecatedAt } : {}),
    ...(record.replacedBy ? { replacedBy: record.replacedBy } : {}),
    supportsResume: record.supportsResume === true,
    ...(includeManagement ? {
      assetKind: record.assetKind,
      discoverable: record.discoverable === true,
      protected: record.protected === true,
      transient: record.transient === true,
      note: record.note || '',
      snapshotName: record.snapshotName
    } : {}),
    ...(includeIntegrity ? {
      sha256: record.sha256,
      size: record.size,
      installedAt: record.installedAt
    } : {})
  };
}

function boundedAssetNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > MAX_ASSET_NOTE_LENGTH) {
    throw new TaskTypeRegistryError(
      'INVALID_TASK_ASSET_NOTE',
      `Task asset note must contain at most ${MAX_ASSET_NOTE_LENGTH} characters`
    );
  }
  return value.trim();
}

function boundedPackText(value, maximum) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : undefined;
}

function comparePackVersions(left, right) {
  const parse = (value) => {
    const [core, prerelease = ''] = String(value).split('-', 2);
    return { numbers: core.split('.').map(Number), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function normalizeManagementRecord(record, systemNames = new Set()) {
  const system = systemNames.has(record.name) || record.assetKind === 'system';
  record.assetKind = system ? 'system' : record.pack ? 'pack' : 'standalone';
  record.protected = system || record.protected === true;
  record.discoverable = system ? false : record.discoverable !== false;
  record.transient = !system && !record.pack && record.transient === true;
  record.note = typeof record.note === 'string' ? record.note.slice(0, MAX_ASSET_NOTE_LENGTH) : '';
  record.deprecatedAt = typeof record.deprecatedAt === 'string' ? record.deprecatedAt : null;
  record.replacedBy = typeof record.replacedBy === 'string' ? record.replacedBy : null;
  if (record.pack) {
    const title = boundedPackText(record.pack.title, 120);
    const description = boundedPackText(record.pack.description, 2_000);
    record.pack = {
      name: record.pack.name,
      version: record.pack.version,
      ...(title ? { title } : {}),
      ...(description ? { description } : {})
    };
  }
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
  if (
    source.interactionContract !== undefined &&
    source.interactionContract !== FULL_HUMAN_INTERACTION_CONTRACT
  ) {
    throw new TaskTypeRegistryError(
      'INVALID_TASK_METADATA',
      `meta.interactionContract must be ${FULL_HUMAN_INTERACTION_CONTRACT}`
    );
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
    ...(source.interactionContract ? { interactionContract: source.interactionContract } : {}),
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

export async function validateTaskModule({
  name,
  modulePath,
  allowedRoots = [],
  inspectionTimeoutMs = DEFAULT_INSPECTION_TIMEOUT_MS
} = {}) {
  if (typeof name !== 'string' || !TASK_TYPE_PATTERN.test(name)) {
    throw new TaskTypeRegistryError(
      'INVALID_TASK_TYPE',
      'Task type must use 1-80 lowercase letters, numbers, dots, underscores, or hyphens'
    );
  }
  if (typeof modulePath !== 'string' || path.extname(modulePath).toLowerCase() !== '.mjs') {
    throw new TaskTypeRegistryError('INVALID_TASK_MODULE', 'Task module must be a .mjs file');
  }
  if (!Number.isInteger(inspectionTimeoutMs) || inspectionTimeoutMs < 100 || inspectionTimeoutMs > 30_000) {
    throw new TypeError('inspectionTimeoutMs must be an integer from 100 to 30000');
  }
  const requested = path.resolve(modulePath);
  const stats = await lstat(requested).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > MAX_TASK_MODULE_BYTES) {
    throw new TaskTypeRegistryError(
      'INVALID_TASK_MODULE_SIZE',
      `Task module must be one regular .mjs file containing 1 to ${MAX_TASK_MODULE_BYTES} bytes`
    );
  }
  const canonical = await realpath(requested);
  const roots = [];
  for (const root of allowedRoots) roots.push(await realpath(path.resolve(root)));
  if (roots.length && !roots.some((root) => inside(root, canonical))) {
    throw new TaskTypeRegistryError('TASK_MODULE_OUTSIDE_ALLOWED_ROOTS', 'Task module is outside the validation roots', 403);
  }
  const source = await readFile(canonical);
  const sha256 = createHash('sha256').update(source).digest('hex');
  const metadata = await inspectTaskModule(canonical, sha256, name, inspectionTimeoutMs);
  await verifySnapshot(canonical, sha256);
  return {
    ok: true,
    taskType: {
      id: name,
      name,
      ...metadata,
      sha256,
      size: source.length
    }
  };
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
    const systemNames = new Set(this.#seedTypes.map((seed) => seed.name));
    await this.#store.update((data) => {
      for (const record of data.types) normalizeManagementRecord(record, systemNames);
    });
    for (const seed of this.#seedTypes) {
      await this.#install({
        ...seed,
        assetKind: 'system',
        protected: true,
        discoverable: false,
        transient: false
      }, { allowUpdate: true });
    }
    await this.#store.update((data) => {
      for (const record of data.types) normalizeManagementRecord(record, systemNames);
    });
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
    const packReference = pack === undefined
      ? null
      : (
          pack &&
          typeof pack.name === 'string' && DISCOVERY_TOKEN.test(pack.name) &&
          typeof pack.version === 'string' && PACK_VERSION_PATTERN.test(pack.version) && pack.version.length <= 64 &&
          pack.interactionContract === FULL_HUMAN_INTERACTION_CONTRACT
            ? {
                name: pack.name,
                version: pack.version,
                ...(boundedPackText(pack.title, 120) ? { title: boundedPackText(pack.title, 120) } : {}),
                ...(boundedPackText(pack.description, 2_000)
                  ? { description: boundedPackText(pack.description, 2_000) }
                  : {}),
                interactionContract: FULL_HUMAN_INTERACTION_CONTRACT
              }
            : null
        );
    if (pack !== undefined && !packReference) {
      throw new TaskTypeRegistryError(
        'INVALID_TASK_PACK',
        `Task Pack name, version, or ${FULL_HUMAN_INTERACTION_CONTRACT} interaction contract is invalid`
      );
    }
    const snapshot = await this.#store.read();
    if (packReference) {
      const newer = snapshot.types.find((record) => (
        record.pack?.name === packReference.name &&
        comparePackVersions(record.pack.version, packReference.version) > 0
      ));
      if (newer) {
        throw new TaskTypeRegistryError(
          'TASK_PACK_VERSION_REGRESSION',
          `Task Pack ${packReference.name} ${newer.pack.version} is newer than ${packReference.version}`,
          409
        );
      }
    }
    const prepared = [];
    for (const input of inputs) {
      const candidate = await this.#prepareInstall(input, { currentTypes: snapshot.types });
      if (candidate.changed && packReference) {
        candidate.record.pack = { ...packReference };
        candidate.record.assetKind = 'pack';
        candidate.record.discoverable = true;
        candidate.record.protected = false;
        candidate.record.transient = false;
        candidate.record.interactionContract = FULL_HUMAN_INTERACTION_CONTRACT;
      }
      if (packReference) {
        validateFullHumanPackSource(await readFile(path.join(this.#snapshotRoot, candidate.record.snapshotName)));
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
        if (current?.pack && packReference && current.pack.name !== packReference.name) {
          throw new TaskTypeRegistryError(
            'TASK_TYPE_PACK_CONFLICT',
            `Task type ${candidate.record.name} already belongs to Task Pack ${current.pack.name}`,
            409
          );
        }
      }
      for (const candidate of prepared) {
        const current = data.types.find((item) => item.name === candidate.record.name);
        if (current) {
          if (packReference) {
            current.pack = { ...packReference };
            current.assetKind = 'pack';
            current.discoverable = true;
            current.protected = false;
            current.transient = false;
            current.interactionContract = FULL_HUMAN_INTERACTION_CONTRACT;
          }
          installed.push(current);
        }
        else {
          data.types.push(candidate.record);
          installed.push(candidate.record);
        }
      }
      if (packReference) {
        const deprecatedAt = new Date().toISOString();
        for (const record of data.types) {
          if (
            record.pack?.name === packReference.name &&
            comparePackVersions(record.pack.version, packReference.version) < 0 &&
            !record.protected
          ) {
            record.deprecatedAt ||= deprecatedAt;
            record.replacedBy = null;
          }
        }
      }
    });
    return installed.map((record) => publicType(record));
  }

  async #prepareInstall({
    name,
    modulePath,
    assetKind = 'standalone',
    discoverable = true,
    protected: protectedAsset = false,
    transient = false,
    note = ''
  } = {}, { allowUpdate = false, currentTypes = [] } = {}) {
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
      assetKind: ASSET_KINDS.has(assetKind) ? assetKind : 'standalone',
      discoverable: discoverable !== false,
      protected: protectedAsset === true,
      transient: transient === true,
      note: boundedAssetNote(note),
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
    if (!prepared.changed) {
      let current = prepared.record;
      await this.#store.update((data) => {
        const record = data.types.find((item) => item.name === prepared.record.name);
        if (!record) return;
        if (input.assetKind === 'system') {
          record.assetKind = 'system';
          record.protected = true;
          record.discoverable = false;
          record.transient = false;
        }
        current = record;
      });
      return publicType(current);
    }
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

  async list({ includeDeprecated = true } = {}) {
    await this.#ready;
    const data = await this.#store.read();
    return data.types
      .filter((record) => includeDeprecated || !record.deprecatedAt)
      .map(publicType)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async listSummaries({ includeDeprecated = false } = {}) {
    await this.#ready;
    const data = await this.#store.read();
    return data.types
      .filter((record) => record.discoverable !== false && (includeDeprecated || !record.deprecatedAt))
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

  async listManagement() {
    await this.#ready;
    const data = await this.#store.read();
    return data.types
      .map((record) => publicType(record, {
        includeSchema: false,
        includeIntegrity: true,
        includeManagement: true
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async setNoteMany(names, note) {
    await this.#ready;
    const normalized = this.#validateNames(names);
    const safeNote = boundedAssetNote(note);
    const updated = [];
    await this.#store.update((data) => {
      for (const name of normalized) {
        const record = data.types.find((item) => item.name === name);
        if (!record) throw new TaskTypeRegistryError('TASK_TYPE_NOT_FOUND', `Task type ${name} was not found`, 404);
        record.note = safeNote;
        updated.push(record);
      }
    });
    return updated.map((record) => publicType(record, {
      includeSchema: false,
      includeIntegrity: false,
      includeManagement: true
    }));
  }

  async setLifecycleMany(names, lifecycle) {
    await this.#ready;
    const normalized = this.#validateNames(names);
    if (!['active', 'deprecated'].includes(lifecycle)) {
      throw new TaskTypeRegistryError('INVALID_TASK_TYPE_LIFECYCLE', 'Lifecycle must be active or deprecated');
    }
    const changed = [];
    await this.#store.update((data) => {
      for (const name of normalized) {
        const record = data.types.find((item) => item.name === name);
        if (!record) throw new TaskTypeRegistryError('TASK_TYPE_NOT_FOUND', `Task type ${name} was not found`, 404);
        if (record.protected) {
          throw new TaskTypeRegistryError('TASK_ASSET_PROTECTED', `System task type ${name} cannot change lifecycle`, 409);
        }
        record.deprecatedAt = lifecycle === 'deprecated' ? (record.deprecatedAt || new Date().toISOString()) : null;
        record.replacedBy = null;
        changed.push(record);
      }
    });
    return changed.map((record) => publicType(record, {
      includeSchema: false,
      includeIntegrity: false,
      includeManagement: true
    }));
  }

  async removeMany(names) {
    await this.#ready;
    const normalized = this.#validateNames(names);
    const removed = [];
    await this.#store.update((data) => {
      for (const name of normalized) {
        const record = data.types.find((item) => item.name === name);
        if (!record) throw new TaskTypeRegistryError('TASK_TYPE_NOT_FOUND', `Task type ${name} was not found`, 404);
        if (record.protected) {
          throw new TaskTypeRegistryError('TASK_ASSET_PROTECTED', `System task type ${name} cannot be deleted`, 409);
        }
        removed.push(record);
      }
      data.types = data.types.filter((record) => !normalized.includes(record.name));
    });
    for (const record of removed) {
      const candidate = path.resolve(this.#snapshotRoot, record.snapshotName);
      if (inside(this.#snapshotRoot, candidate)) await rm(candidate, { force: true });
    }
    return removed.map((record) => publicType(record, {
      includeSchema: false,
      includeIntegrity: false,
      includeManagement: true
    }));
  }

  async snapshotInventory() {
    await this.#ready;
    const data = await this.#store.read();
    const registered = new Set(data.types.map((record) => record.snapshotName));
    const entries = await readdir(this.#snapshotRoot, { withFileTypes: true });
    const inventory = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-z][a-z0-9._-]{0,79}-[a-f0-9]{64}\.mjs$/u.test(entry.name)) continue;
      const stats = await lstat(path.join(this.#snapshotRoot, entry.name)).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!stats?.isFile()) continue;
      inventory.push({
        snapshotName: entry.name,
        sha256: entry.name.slice(-68, -4),
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        registered: registered.has(entry.name)
      });
    }
    return inventory.sort((left, right) => left.snapshotName.localeCompare(right.snapshotName));
  }

  async removeSnapshots(snapshotNames) {
    await this.#ready;
    if (!Array.isArray(snapshotNames) || snapshotNames.length < 1 || snapshotNames.length > 256) {
      throw new TaskTypeRegistryError('INVALID_TASK_ASSET_BATCH', 'Snapshot batch must contain 1 to 256 items');
    }
    const data = await this.#store.read();
    const registered = new Set(data.types.map((record) => record.snapshotName));
    const removed = [];
    for (const snapshotName of [...new Set(snapshotNames)]) {
      if (typeof snapshotName !== 'string' || !/^[a-z][a-z0-9._-]{0,79}-[a-f0-9]{64}\.mjs$/u.test(snapshotName)) {
        throw new TaskTypeRegistryError('INVALID_TASK_SNAPSHOT', 'Task snapshot name is invalid');
      }
      if (registered.has(snapshotName)) {
        throw new TaskTypeRegistryError('TASK_SNAPSHOT_REGISTERED', 'Registered snapshots must be deleted through their asset', 409);
      }
      await rm(path.join(this.#snapshotRoot, snapshotName), { force: true });
      removed.push(snapshotName);
    }
    return removed;
  }

  #validateNames(names) {
    if (
      !Array.isArray(names) || names.length < 1 || names.length > 256 ||
      names.some((name) => typeof name !== 'string' || !TASK_TYPE_PATTERN.test(name))
    ) {
      throw new TaskTypeRegistryError('INVALID_TASK_ASSET_BATCH', 'Task asset batch must contain 1 to 256 valid task types');
    }
    return [...new Set(names)];
  }

  async resolve(name) {
    await this.#ready;
    const data = await this.#store.read();
    const record = data.types.find((item) => item.name === name);
    if (!record) {
      throw new TaskTypeRegistryError('TASK_TYPE_NOT_FOUND', `Task type ${name} was not found`, 404);
    }
    if (record.deprecatedAt) {
      throw new TaskTypeRegistryError(
        'TASK_TYPE_DEPRECATED',
        record.replacedBy
          ? `Task type ${name} is deprecated; use ${record.replacedBy}`
          : `Task type ${name} is deprecated and has no replacement`,
        409
      );
    }
    if (record.pack && record.interactionContract !== FULL_HUMAN_INTERACTION_CONTRACT) {
      throw new TaskTypeRegistryError(
        'TASK_PACK_INTERACTION_CONTRACT_REQUIRED',
        `Task Pack ${record.pack.name} must be reinstalled with ${FULL_HUMAN_INTERACTION_CONTRACT}`,
        409
      );
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

  async deprecate(name, { replacedBy = null } = {}) {
    await this.#ready;
    if (typeof name !== 'string' || !TASK_TYPE_PATTERN.test(name)) {
      throw new TaskTypeRegistryError('INVALID_TASK_TYPE', 'Task type name is invalid');
    }
    if (replacedBy !== null && (typeof replacedBy !== 'string' || !TASK_TYPE_PATTERN.test(replacedBy) || replacedBy === name)) {
      throw new TaskTypeRegistryError('INVALID_TASK_REPLACEMENT', 'Replacement must be a different installed task type');
    }
    let deprecated;
    await this.#store.update((data) => {
      const record = data.types.find((item) => item.name === name);
      if (!record) throw new TaskTypeRegistryError('TASK_TYPE_NOT_FOUND', `Task type ${name} was not found`, 404);
      if (replacedBy) {
        const replacement = data.types.find((item) => item.name === replacedBy && !item.deprecatedAt);
        if (!replacement) {
          throw new TaskTypeRegistryError('TASK_TYPE_REPLACEMENT_NOT_FOUND', `Active replacement ${replacedBy} was not found`, 404);
        }
      }
      record.deprecatedAt ??= new Date().toISOString();
      record.replacedBy = replacedBy;
      deprecated = record;
    });
    return publicType(deprecated, { includeSchema: false, includeIntegrity: false });
  }

  async restore(name) {
    await this.#ready;
    let restored;
    await this.#store.update((data) => {
      const record = data.types.find((item) => item.name === name);
      if (!record) throw new TaskTypeRegistryError('TASK_TYPE_NOT_FOUND', `Task type ${name} was not found`, 404);
      record.deprecatedAt = null;
      record.replacedBy = null;
      restored = record;
    });
    return publicType(restored, { includeSchema: false, includeIntegrity: false });
  }
}
