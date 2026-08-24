import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION, isSettledTerminalTask, VERSION } from '../contracts.mjs';
import {
  createIdentityNonce,
  MANAGER_SERVICE,
  validateManagerIdentityPin,
  verifyManagerIdentityProof
} from '../lib/manager-identity.mjs';
import { TaskMasterClientError } from './errors.mjs';

const DEFAULT_PORT = 19_946;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const PROFILE_OPEN_REQUEST_TIMEOUT_MS = 75_000;
const PROFILE_CLOSE_REQUEST_TIMEOUT_MS = 45_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^\S{32,512}$/;
const FORBIDDEN_INPUT_KEY = /^(?:module_?path|evaluate|authorization|auth_?header|cookies?|password|passwd|secrets?|credentials?|api_?key|token|(?:access|refresh|api|auth|bearer|session)_?token|session(?:_?id|_?token)?)$/i;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TASKMASTER_CLIENT_METHODS = Object.freeze([
  'getStatus',
  'listProfiles',
  'createProfile',
  'updateProfile',
  'openProfile',
  'closeProfile',
  'listTaskTypes',
  'describeTaskType',
  'startTask',
  'listTasks',
  'getTask',
  'waitTask',
  'continueTask',
  'resumeTask',
  'cancelTask',
  'listArtifacts',
  'readArtifact'
]);

function clientError(code, message, options) {
  return new TaskMasterClientError(code, message, options);
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw clientError('INVALID_IDENTIFIER', `${label} must be a stable identifier.`);
  }
  return value;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw clientError('INVALID_ARGUMENT', `${label} must be an object.`);
  }
  return value;
}

function assertAllowedKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw clientError('UNKNOWN_ARGUMENT', `${label} contains an unsupported field.`);
}

function serializedSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw clientError('INVALID_JSON_VALUE', 'The value must contain JSON-compatible data only.');
  }
}

export function assertSafeTaskInput(value) {
  assertPlainObject(value, 'Task input');
  if (serializedSize(value) > MAX_REQUEST_BYTES) {
    throw clientError('TASK_INPUT_TOO_LARGE', `Task input exceeds ${MAX_REQUEST_BYTES} bytes.`);
  }
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object') return;
    if (depth > 12) throw clientError('TASK_INPUT_TOO_DEEP', 'Task input nesting is too deep.');
    if (seen.has(node)) throw clientError('INVALID_JSON_VALUE', 'Task input must not contain cycles.');
    seen.add(node);
    if (!Array.isArray(node)) {
      for (const key of Object.keys(node)) {
        if (FORBIDDEN_INPUT_KEY.test(key)) {
          throw clientError('FORBIDDEN_TASK_INPUT', 'Task input contains a credential or low-level execution field.');
        }
      }
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) visit(child, depth + 1);
    seen.delete(node);
  };
  visit(value, 0);
  return value;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw clientError('INVALID_MANAGER_URL', 'Task Master manager URL is invalid.');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw clientError('LOOPBACK_REQUIRED', 'MCP may connect only to a plain HTTP manager on 127.0.0.1.');
  }
  return url;
}

function delay(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(clientError('REQUEST_CANCELLED', 'The MCP request was cancelled.'));
  }
  return new Promise((resolveWait, rejectWait) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolveWait();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      rejectWait(clientError('REQUEST_CANCELLED', 'The MCP request was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createRequestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    }
  };
}

async function readBoundedText(response, maxBytes, abortController) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    abortController?.abort();
    throw clientError('MANAGER_RESPONSE_TOO_LARGE', 'Task Master manager response exceeded the allowed size.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      abortController?.abort();
      await reader.cancel().catch(() => {});
      throw clientError('MANAGER_RESPONSE_TOO_LARGE', 'Task Master manager response exceeded the allowed size.');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function remoteError(status, payload) {
  const candidate = payload?.error?.code ?? payload?.code;
  const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate)
    ? candidate
    : `HTTP_${status}`;
  if (status === 401) {
    return clientError(code, 'Task Master rejected the scoped agent credential.', {
      retryable: true,
      statusCode: status,
      nextAction: 'Reconnect the MCP server so Task Master can issue a fresh agent credential.'
    });
  }
  if (status === 403) {
    return clientError(code, 'This Agent is not authorized for the requested Task Master resource.', {
      retryable: false,
      statusCode: status,
      nextAction: 'Use a Profile owned by this Agent, or explicitly share the intended Profile.'
    });
  }
  if (status === 404) {
    return clientError(code, 'The requested scoped Task Master endpoint is unavailable.', {
      statusCode: status,
      nextAction: 'Start or upgrade the Task Master manager before retrying.'
    });
  }
  if (status === 409) {
    return clientError(code, 'Task Master rejected the operation because its state changed.', {
      retryable: true,
      statusCode: status,
      nextAction: 'Read the latest task or profile state before retrying.'
    });
  }
  if (status === 429) {
    return clientError(code, 'Task Master is rate limited.', {
      retryable: true,
      statusCode: status,
      nextAction: 'Wait for the manager-provided cooldown before retrying.'
    });
  }
  return clientError(code, 'Task Master manager rejected the request.', {
    retryable: status >= 500,
    statusCode: status,
    ...(status >= 500 ? { nextAction: 'Retry once, then inspect manager status.' } : {})
  });
}

function buildQuery(pathname, values) {
  const url = new URL(pathname, 'http://127.0.0.1');
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

export function assertTaskMasterClient(client) {
  if (!client || typeof client !== 'object') throw new TypeError('TaskMasterClient is required');
  const missing = TASKMASTER_CLIENT_METHODS.filter((method) => typeof client[method] !== 'function');
  if (missing.length) throw new TypeError(`TaskMasterClient is missing: ${missing.join(', ')}`);
  return client;
}

export class HttpTaskMasterClient {
  #baseUrl;
  #clientId;
  #clientName;
  #stateDir;
  #fetch;
  #requestTimeoutMs;
  #agentToken;
  #agentTokenPromise;
  #ensureManager;

  constructor({
    baseUrl,
    clientId,
    clientName = 'MCP Agent',
    stateDir,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ensureManager
  } = {}) {
    this.#baseUrl = normalizeBaseUrl(baseUrl ?? `http://127.0.0.1:${DEFAULT_PORT}`);
    this.#clientId = assertIdentifier(clientId, 'clientId');
    if (typeof clientName !== 'string' || !clientName.trim() || clientName.length > 80) {
      throw clientError('INVALID_CLIENT_NAME', 'clientName must contain 1 to 80 characters.');
    }
    this.#clientName = clientName.trim();
    this.#stateDir = resolve(stateDir ?? join(homedir(), '.eric-task-master'));
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.#fetch = fetchImpl;
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw clientError(
        'INVALID_TIMEOUT',
        `requestTimeoutMs must be an integer from 100 to ${MAX_REQUEST_TIMEOUT_MS}.`
      );
    }
    this.#requestTimeoutMs = requestTimeoutMs;
    if (ensureManager !== undefined && typeof ensureManager !== 'function') {
      throw new TypeError('ensureManager must be a function');
    }
    this.#ensureManager = ensureManager;
  }

  async getStatus() {
    const payload = await this.#request('/v1/health');
    return payload.status ?? payload;
  }

  async listProfiles() {
    const payload = await this.#request('/v1/profiles');
    return Array.isArray(payload.profiles) ? payload.profiles : [];
  }

  async createProfile(input) {
    assertAllowedKeys(input, new Set(['name', 'kind', 'defaultBehavior', 'headless', 'browserChannel', 'access']), 'Profile request');
    return (await this.#request('/v1/profiles', { method: 'POST', body: input })).profile;
  }

  async updateProfile(profileId, patch) {
    assertIdentifier(profileId, 'profileId');
    assertAllowedKeys(
      patch,
      new Set(['name', 'defaultBehavior', 'headless', 'browserChannel', 'access']),
      'Profile patch'
    );
    return (await this.#request(`/v1/profiles/${encodeURIComponent(profileId)}`, {
      method: 'PATCH',
      body: patch
    })).profile;
  }

  async openProfile(profileId) {
    assertIdentifier(profileId, 'profileId');
    return (await this.#request(`/v1/profiles/${encodeURIComponent(profileId)}/open`, {
      method: 'POST',
      body: {},
      timeoutMs: Math.max(this.#requestTimeoutMs, PROFILE_OPEN_REQUEST_TIMEOUT_MS)
    })).profile;
  }

  async closeProfile(profileId) {
    assertIdentifier(profileId, 'profileId');
    return (await this.#request(`/v1/profiles/${encodeURIComponent(profileId)}/close`, {
      method: 'POST',
      body: {},
      timeoutMs: Math.max(this.#requestTimeoutMs, PROFILE_CLOSE_REQUEST_TIMEOUT_MS)
    })).profile;
  }

  async listTaskTypes(input = {}) {
    assertAllowedKeys(input, new Set(['query', 'domain', 'intent']), 'Task type list request');
    const payload = await this.#request(buildQuery('/v1/task-types', input));
    return Array.isArray(payload.taskTypes) ? payload.taskTypes : [];
  }

  async describeTaskType(taskType) {
    assertIdentifier(taskType, 'taskType');
    return (await this.#request(`/v1/task-types/${encodeURIComponent(taskType)}`)).taskType;
  }

  async startTask(input) {
    assertAllowedKeys(input, new Set(['taskType', 'profileId', 'input', 'behavior', 'timeoutMs', 'idempotencyKey']), 'Task request');
    assertIdentifier(input.taskType, 'taskType');
    assertIdentifier(input.profileId, 'profileId');
    assertIdentifier(input.idempotencyKey, 'idempotencyKey');
    if (input.idempotencyKey.length < 8) {
      throw clientError('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must contain at least 8 characters.');
    }
    assertSafeTaskInput(input.input);
    return (await this.#request('/v1/tasks', { method: 'POST', body: input })).task;
  }

  async listTasks(input = {}) {
    assertAllowedKeys(input, new Set(['cursor', 'limit']), 'Task list request');
    const payload = await this.#request(buildQuery('/v1/tasks', input));
    return {
      tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
      ...(typeof payload.nextCursor === 'string' ? { nextCursor: payload.nextCursor } : {})
    };
  }

  async getTask(taskId) {
    assertIdentifier(taskId, 'taskId');
    return (await this.#request(`/v1/tasks/${encodeURIComponent(taskId)}`)).task;
  }

  async waitTask(taskId, { waitMs = 30_000, signal, onProgress } = {}) {
    assertIdentifier(taskId, 'taskId');
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
      throw clientError('INVALID_WAIT', 'waitMs must be an integer from 0 to 30000.');
    }
    const deadline = Date.now() + waitMs;
    let task;
    do {
      task = (await this.#request(`/v1/tasks/${encodeURIComponent(taskId)}`, { signal })).task;
      if (typeof onProgress === 'function') await onProgress(task?.progress, task);
      if (isSettledTerminalTask(task)) return { task, timedOut: false };
      if (task?.state === 'waiting_user' || task?.health?.status === 'stalled') {
        return { task, timedOut: false };
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(500, Math.max(1, deadline - Date.now())), signal);
    } while (Date.now() <= deadline);
    return { task, timedOut: true };
  }

  async cancelTask(taskId) {
    assertIdentifier(taskId, 'taskId');
    return (await this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: {} })).task;
  }

  async continueTask(input) {
    assertAllowedKeys(input, new Set(['taskId', 'requestId', 'note']), 'Task continue request');
    assertIdentifier(input.taskId, 'taskId');
    if (input.requestId !== undefined) assertIdentifier(input.requestId, 'requestId');
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2_000)) {
      throw clientError('INVALID_TASK_CONTINUE', 'note must contain at most 2000 characters.');
    }
    return (await this.#request(`/v1/tasks/${encodeURIComponent(input.taskId)}/continue`, {
      method: 'POST',
      body: {
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.note ? { note: input.note } : {})
      }
    })).task;
  }

  async resumeTask(input) {
    assertAllowedKeys(input, new Set(['taskId', 'resumeKey']), 'Task resume request');
    assertIdentifier(input.taskId, 'taskId');
    assertIdentifier(input.resumeKey, 'resumeKey');
    if (input.resumeKey.length < 8) {
      throw clientError('INVALID_RESUME_KEY', 'resumeKey must contain at least 8 characters.');
    }
    const payload = await this.#request(`/v1/tasks/${encodeURIComponent(input.taskId)}/resume`, {
      method: 'POST',
      body: { resumeKey: input.resumeKey }
    });
    return {
      task: payload.task,
      ...(typeof payload.notice === 'string' ? { notice: payload.notice } : {})
    };
  }

  async listArtifacts(taskId) {
    assertIdentifier(taskId, 'taskId');
    const payload = await this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts`);
    return Array.isArray(payload.artifacts) ? payload.artifacts : [];
  }

  async readArtifact({ taskId, artifactId, offset = 0, maxBytes = 48 * 1024 }) {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(artifactId, 'artifactId');
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw clientError('INVALID_ARTIFACT_OFFSET', 'Artifact offset must be a non-negative safe integer.');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 48 * 1024) {
      throw clientError('INVALID_ARTIFACT_LIMIT', 'Artifact maxBytes must be an integer from 1 to 49152.');
    }
    const pathname = buildQuery(
      `/v1/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`,
      { offset, maxBytes }
    );
    return this.#request(pathname);
  }

  async #readManagerCredentials() {
    let source;
    try {
      source = await readFile(join(this.#stateDir, 'config.json'));
    } catch {
      throw clientError('MANAGER_TOKEN_UNAVAILABLE', 'Task Master admin credential is unavailable.', {
        nextAction: 'Run the fixed Task Master connect command once.'
      });
    }
    if (source.byteLength > MAX_CONFIG_BYTES) {
      throw clientError('MANAGER_CONFIG_INVALID', 'Task Master manager configuration is invalid.');
    }
    let config;
    try {
      config = JSON.parse(source.toString('utf8'));
    } catch {
      throw clientError('MANAGER_CONFIG_INVALID', 'Task Master manager configuration is invalid.');
    }
    if (typeof config.managerToken !== 'string' || !TOKEN.test(config.managerToken)) {
      throw clientError('MANAGER_TOKEN_UNAVAILABLE', 'Task Master admin credential is unavailable.', {
        nextAction: 'Run the fixed Task Master connect command once.'
      });
    }
    let identity;
    try {
      identity = validateManagerIdentityPin(config.managerIdentity);
    } catch {
      throw clientError('MANAGER_IDENTITY_INVALID', 'Task Master Manager identity pin is unavailable.', {
        nextAction: 'Run the fixed Task Master connect command once.'
      });
    }
    return { token: config.managerToken, identity };
  }

  async #verifyManagerIdentity(identity) {
    const nonce = createIdentityNonce();
    const requestSignal = createRequestSignal(undefined, this.#requestTimeoutMs);
    let response;
    try {
      response = await this.#fetch(new URL('/v1/identity/challenge', this.#baseUrl), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ nonce }),
        signal: requestSignal.signal,
        redirect: 'error'
      });
    } catch {
      requestSignal.cleanup();
      throw clientError('MANAGER_IDENTITY_UNVERIFIED', 'The service on the Manager port did not prove its identity.', {
        nextAction: 'Stop the untrusted local service or restore the original Manager state, then retry.'
      });
    }
    let text;
    try {
      text = await readBoundedText(response, 16 * 1024);
    } catch {
      throw clientError('MANAGER_IDENTITY_UNVERIFIED', 'The service on the Manager port returned an invalid identity proof.');
    } finally {
      requestSignal.cleanup();
    }
    if (!response.ok) {
      throw clientError('MANAGER_IDENTITY_UNVERIFIED', 'The service on the Manager port rejected identity verification.');
    }
    let proof;
    try {
      proof = JSON.parse(text);
      verifyManagerIdentityProof(proof, identity, {
        service: MANAGER_SERVICE,
        version: VERSION,
        apiVersion: API_VERSION,
        host: this.#baseUrl.hostname,
        port: Number(this.#baseUrl.port || 80),
        nonce
      });
    } catch (error) {
      throw clientError(
        typeof error?.code === 'string' && error.code.startsWith('MANAGER_IDENTITY_')
          ? error.code
          : 'MANAGER_IDENTITY_UNVERIFIED',
        'The service on the Manager port did not match the pinned Manager identity.',
        { nextAction: 'Stop the untrusted local service or restore the original Manager state, then retry.' }
      );
    }
  }

  async #ensureAgentToken() {
    if (this.#agentToken) return this.#agentToken;
    if (!this.#agentTokenPromise) {
      this.#agentTokenPromise = this.#issueAgentToken().finally(() => {
        this.#agentTokenPromise = undefined;
      });
    }
    return this.#agentTokenPromise;
  }

  async #issueAgentToken() {
    const credentials = await this.#readManagerCredentials();
    await this.#verifyManagerIdentity(credentials.identity);
    let payload;
    try {
      payload = await this.#requestJson('/v1/agents/issue', {
        method: 'POST',
        body: { clientId: this.#clientId, name: this.#clientName },
        token: credentials.token
      });
    } catch (error) {
      if (error instanceof TaskMasterClientError && error.statusCode === 404) {
        throw clientError('SCOPED_AGENT_API_UNAVAILABLE', 'This Task Master manager does not support scoped MCP agents.', {
          nextAction: 'Upgrade the Task Master manager before reconnecting MCP.'
        });
      }
      throw error;
    }
    if (!TOKEN.test(payload?.agentToken ?? '') || payload?.agent?.clientId !== this.#clientId) {
      throw clientError('INVALID_AGENT_CREDENTIAL', 'Task Master returned an invalid scoped agent credential.');
    }
    this.#agentToken = payload.agentToken;
    return this.#agentToken;
  }

  async #request(pathname, options = {}) {
    await this.#ensureManager?.();
    let token = await this.#ensureAgentToken();
    try {
      return await this.#requestJson(pathname, { ...options, token });
    } catch (error) {
      if (!(error instanceof TaskMasterClientError) || error.statusCode !== 401) {
        throw error;
      }
      this.#agentToken = undefined;
      token = await this.#ensureAgentToken();
      return this.#requestJson(pathname, { ...options, token });
    }
  }

  async #requestJson(pathname, {
    method = 'GET',
    body,
    token,
    signal: parentSignal,
    timeoutMs = this.#requestTimeoutMs
  } = {}) {
    const url = new URL(pathname, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) {
      throw clientError('LOOPBACK_REQUIRED', 'Task Master request escaped the configured manager origin.');
    }
    let encodedBody;
    if (body !== undefined) {
      encodedBody = JSON.stringify(body);
      if (Buffer.byteLength(encodedBody) > MAX_REQUEST_BYTES) {
        throw clientError('REQUEST_TOO_LARGE', `Task Master request exceeds ${MAX_REQUEST_BYTES} bytes.`);
      }
    }
    const requestSignal = createRequestSignal(parentSignal, timeoutMs);
    let response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(encodedBody === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
        signal: requestSignal.signal,
        redirect: 'error'
      });
    } catch {
      requestSignal.cleanup();
      if (parentSignal?.aborted) throw clientError('REQUEST_CANCELLED', 'The MCP request was cancelled.');
      if (requestSignal.signal.aborted) {
        throw clientError('MANAGER_TIMEOUT', 'Task Master manager did not respond before the request deadline.', {
          retryable: true,
          nextAction: 'Read manager status before retrying the operation.'
        });
      }
      throw clientError('MANAGER_UNREACHABLE', 'Task Master manager could not be reached.', {
        retryable: true,
        nextAction: 'Start Task Master with the fixed connect command and retry once.'
      });
    }
    let text;
    try {
      text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof TaskMasterClientError) throw error;
      if (parentSignal?.aborted) throw clientError('REQUEST_CANCELLED', 'The MCP request was cancelled.');
      if (requestSignal.signal.aborted) {
        throw clientError('MANAGER_TIMEOUT', 'Task Master manager did not finish its response before the request deadline.', {
          retryable: true,
          nextAction: 'Read manager status before retrying the operation.'
        });
      }
      throw clientError('MANAGER_CONNECTION_LOST', 'Task Master manager closed the response unexpectedly.', {
        retryable: true,
        nextAction: 'Read manager status before retrying the operation.'
      });
    } finally {
      requestSignal.cleanup();
    }
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw clientError('INVALID_MANAGER_RESPONSE', 'Task Master manager returned invalid JSON.');
      }
    }
    if (!response.ok) throw remoteError(response.status, payload);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw clientError('INVALID_MANAGER_RESPONSE', 'Task Master manager returned an invalid response shape.');
    }
    return payload;
  }
}

function createManagerStarter({ baseUrl, host, port, stateDir, fetchImpl = globalThis.fetch } = {}) {
  let starting;

  async function probe(timeoutMs = 1_000) {
    let response;
    try {
      response = await fetchImpl(new URL('/v1/health', baseUrl), {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    if (payload?.service !== 'eric-task-master') {
      throw clientError('MANAGER_PORT_CONFLICT', 'The Task Master port belongs to another local service.');
    }
    if (payload.version !== VERSION) {
      throw clientError(
        'MANAGER_VERSION_MISMATCH',
        `Running Task Master ${payload.version || 'unknown'} does not match MCP ${VERSION}.`,
        { nextAction: 'Stop the older Manager and reconnect Task Master once.' }
      );
    }
    return payload;
  }

  async function start() {
    if (await probe()) return;
    const child = spawn(process.execPath, [
      resolve(PROJECT_ROOT, 'src', 'cli.mjs'),
      'serve',
      '--host', host,
      '--port', String(port),
      '--state-dir', stateDir,
      '--json'
    ], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    let spawnError;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.unref();

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw clientError('MANAGER_START_FAILED', 'Task Master Manager process could not be started.', {
          nextAction: 'Run the fixed Task Master connect command once and inspect its error.'
        });
      }
      const health = await probe(1_000);
      if (health) return;
      await delay(150);
    }
    throw clientError('MANAGER_START_TIMEOUT', 'Task Master Manager did not become ready in time.', {
      retryable: true,
      nextAction: 'Run the fixed Task Master connect command once and inspect its error.'
    });
  }

  return async () => {
    if (!starting) {
      starting = start().finally(() => {
        starting = undefined;
      });
    }
    return starting;
  };
}

export function createDefaultTaskMasterClient(env = process.env) {
  const host = env.ERIC_TASK_MASTER_HOST ?? '127.0.0.1';
  const port = Number(env.ERIC_TASK_MASTER_PORT ?? DEFAULT_PORT);
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw clientError('INVALID_MANAGER_ADDRESS', 'MCP requires a valid Task Master manager on 127.0.0.1.');
  }
  const clientId = env.ERIC_TASK_MASTER_CLIENT_ID ?? env.TASKMASTER_CLIENT_ID;
  const clientName = env.ERIC_TASK_MASTER_CLIENT_NAME ?? env.TASKMASTER_CLIENT_NAME ?? 'MCP Agent';
  const stateDir = resolve(env.ERIC_TASK_MASTER_HOME || join(homedir(), '.eric-task-master'));
  const baseUrl = `http://${host}:${port}`;
  return new HttpTaskMasterClient({
    baseUrl,
    clientId,
    clientName,
    stateDir,
    ensureManager: createManagerStarter({ baseUrl, host, port, stateDir })
  });
}
