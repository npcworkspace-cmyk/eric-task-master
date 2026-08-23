import http from 'node:http';
import os from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { JsonStore } from './lib/json-store.mjs';
import { ProfileStore, ProfileStoreError } from './lib/profile-store.mjs';
import {
  HttpError,
  corsHeaders,
  isChromeExtensionOrigin,
  parseBearer,
  readJson,
  requestOrigin,
  sendEmpty,
  sendJson,
  serveStatic
} from './lib/http-utils.mjs';
import {
  API_VERSION,
  DEFAULT_HOST,
  DEFAULT_PORT,
  VERSION,
  publicProfile,
  publicTask
} from './contracts.mjs';

const PAIRING_CHALLENGE_TTL_MS = 60_000;
const MANAGER_NAME = 'eric-task-master';
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

function defaultDataDirectory() {
  if (process.env.ERIC_TASK_MASTER_HOME) return resolve(process.env.ERIC_TASK_MASTER_HOME);
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local'), MANAGER_NAME);
  }
  if (process.platform === 'darwin') {
    return join(os.homedir(), 'Library', 'Application Support', MANAGER_NAME);
  }
  return join(process.env.XDG_DATA_HOME || join(os.homedir(), '.local', 'share'), MANAGER_NAME);
}

function token() {
  return randomBytes(32).toString('base64url');
}

function tokenHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function secureEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeTaskService(taskService = {}) {
  return taskService || {};
}

function assertLoopbackHost(host) {
  if (host !== DEFAULT_HOST) {
    throw new Error(`Manager must bind to ${DEFAULT_HOST}`);
  }
}

function isLoopbackRequestHost(hostHeader) {
  if (typeof hostHeader !== 'string') return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

function publicExtension(extension) {
  const { tokenHash: _tokenHash, ...safe } = extension;
  return safe;
}

function validateProfilePatch(body) {
  const allowed = new Set(['name', 'defaultBehavior', 'headless', 'browserChannel']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new HttpError(400, 'INVALID_PROFILE_PATCH', `Unsupported fields: ${unknown.join(', ')}`);
  }
  return body;
}

function validateProfileCreate(body) {
  const allowed = new Set(['name', 'defaultBehavior', 'headless', 'browserChannel']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new HttpError(400, 'INVALID_PROFILE_CREATE', `Unsupported fields: ${unknown.join(', ')}`);
  }
  return body;
}

function requireTaskMethod(service, name) {
  if (typeof service[name] !== 'function') {
    throw new HttpError(501, 'TASK_SERVICE_UNAVAILABLE', `Task service does not implement ${name}`);
  }
  return service[name].bind(service);
}

function validatedSessionBundle(body, extension) {
  const allowed = new Set(['origin', 'cookies', 'localStorage', 'source']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new HttpError(400, 'INVALID_SESSION_BUNDLE', `Unsupported fields: ${unknown.join(', ')}`);
  }
  let origin;
  try {
    const parsed = new URL(body.origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== body.origin) throw new Error();
    origin = parsed.origin;
  } catch {
    throw new HttpError(400, 'INVALID_SESSION_ORIGIN', 'origin must be an HTTP(S) origin');
  }
  if (!Array.isArray(body.cookies) || body.cookies.length > 5_000) {
    throw new HttpError(400, 'INVALID_SESSION_COOKIES', 'cookies must be an array of at most 5000 items');
  }
  for (const cookie of body.cookies) {
    if (
      !cookie ||
      typeof cookie !== 'object' ||
      typeof cookie.name !== 'string' ||
      typeof cookie.value !== 'string'
    ) {
      throw new HttpError(400, 'INVALID_SESSION_COOKIE', 'Each cookie must contain string name and value');
    }
  }
  if (!Array.isArray(body.localStorage) || body.localStorage.length > 10_000) {
    throw new HttpError(
      400,
      'INVALID_LOCAL_STORAGE',
      'localStorage must be an array of at most 10000 items'
    );
  }
  for (const item of body.localStorage) {
    if (!item || typeof item.name !== 'string' || typeof item.value !== 'string') {
      throw new HttpError(
        400,
        'INVALID_LOCAL_STORAGE_ITEM',
        'Each localStorage item must contain string name and value'
      );
    }
  }
  if (!body.source || typeof body.source !== 'object' || typeof body.source.tabUrl !== 'string') {
    throw new HttpError(400, 'INVALID_SESSION_SOURCE', 'source.tabUrl is required');
  }
  try {
    if (new URL(body.source.tabUrl).origin !== origin) throw new Error();
  } catch {
    throw new HttpError(400, 'SESSION_SOURCE_ORIGIN_MISMATCH', 'source.tabUrl must match origin');
  }

  return {
    origin,
    cookies: body.cookies,
    localStorage: body.localStorage,
    source: {
      extensionId: extension.id,
      tabUrl: body.source.tabUrl
    }
  };
}

function safeSessionResult(profileId, result) {
  const allowedStatuses = new Set(['partial', 'manual_login_required', 'failed']);
  const status = allowedStatuses.has(result?.status) ? result.status : 'failed';
  const response = {
    profileId,
    status,
    verification: typeof result?.verification === 'string'
      ? result.verification.slice(0, 100)
      : status
  };
  if (Number.isSafeInteger(result?.cookieCount) && result.cookieCount >= 0) {
    response.cookieCount = result.cookieCount;
  }
  if (Number.isSafeInteger(result?.localStorageCount) && result.localStorageCount >= 0) {
    response.localStorageCount = result.localStorageCount;
  }
  if (
    Number.isSafeInteger(result?.sessionCookieRetentionHours) &&
    result.sessionCookieRetentionHours >= 0 &&
    result.sessionCookieRetentionHours <= 24
  ) {
    response.sessionCookieRetentionHours = result.sessionCookieRetentionHours;
  }
  return response;
}

function errorResponse(error) {
  if (error instanceof HttpError || error instanceof ProfileStoreError) {
    return {
      statusCode: error.statusCode,
      body: {
        code: error.code,
        message: error.message,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      }
    };
  }
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600) {
    return {
      statusCode: error.statusCode,
      body: {
        code: typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
        message: typeof error.message === 'string' ? error.message : 'Request failed',
        error: {
          code: typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
          message: typeof error.message === 'string' ? error.message : 'Request failed'
        }
      }
    };
  }
  return {
    statusCode: 500,
    body: {
      code: 'INTERNAL_ERROR',
      message: 'Internal manager error',
      error: { code: 'INTERNAL_ERROR', message: 'Internal manager error' }
    }
  };
}

export async function createManager({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  dataDir = defaultDataDirectory(),
  dashboardDir = resolve(MODULE_DIRECTORY, '..', 'dashboard'),
  taskService: suppliedTaskService,
  taskServiceFactory,
  now = () => Date.now(),
  profileProcessAlive
} = {}) {
  assertLoopbackHost(host);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('port must be an integer from 0 to 65535');
  }
  const resolvedDataDir = resolve(dataDir);
  const configStore = new JsonStore(join(resolvedDataDir, 'config.json'), () => ({
    version: 1,
    managerToken: token(),
    createdAt: new Date(now()).toISOString(),
    extensions: []
  }));
  await configStore.init();
  let config = await configStore.read();
  if (typeof config.managerToken !== 'string' || config.managerToken.length < 32) {
    config = await configStore.update((draft) => {
      draft.managerToken = token();
      draft.extensions = Array.isArray(draft.extensions) ? draft.extensions : [];
    });
  }
  if (!Array.isArray(config.extensions)) {
    config = await configStore.update((draft) => {
      draft.extensions = [];
    });
  }

  const profileStore = new ProfileStore({
    filePath: join(resolvedDataDir, 'profiles.json'),
    profilesRoot: join(resolvedDataDir, 'profiles'),
    now,
    ...(profileProcessAlive ? { processAlive: profileProcessAlive } : {})
  });
  await profileStore.init();

  const stateDir = join(resolvedDataDir, 'tasks');
  const createdTaskService = suppliedTaskService === undefined && typeof taskServiceFactory === 'function'
    ? await taskServiceFactory({ profileStore, stateDir })
    : suppliedTaskService;
  const taskService = normalizeTaskService(createdTaskService);
  const challenges = new Map();
  let server;
  let startedAt;
  let listeningAddress;

  function currentCors(request) {
    const origin = requestOrigin(request);
    if (!origin) return {};
    let sameManager = false;
    try {
      const parsed = new URL(origin);
      sameManager = parsed.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(parsed.hostname) &&
        Number(parsed.port || 80) === (listeningAddress?.port ?? port);
    } catch {
      sameManager = false;
    }
    if (sameManager || isChromeExtensionOrigin(origin)) return corsHeaders(origin);
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
  }

  async function authenticate(request, { extensionOnly = false } = {}) {
    const bearer = parseBearer(request);
    if (!bearer) throw new HttpError(401, 'AUTH_REQUIRED', 'Bearer token is required');
    const origin = requestOrigin(request);
    if (!extensionOnly && secureEqual(bearer, config.managerToken)) {
      return { role: 'manager' };
    }
    const hashed = tokenHash(bearer);
    const extension = config.extensions.find((item) => secureEqual(item.tokenHash, hashed));
    if (!extension) throw new HttpError(401, 'INVALID_TOKEN', 'Bearer token is invalid');
    return { role: 'extension', extension };
  }

  async function pairExtension(request, response, cors) {
    const origin = requestOrigin(request);
    if (!isChromeExtensionOrigin(origin)) {
      throw new HttpError(403, 'EXTENSION_ORIGIN_REQUIRED', 'Chrome extension origin is required');
    }
    const body = await readJson(request, { maxBytes: 16 * 1024 });
    const challengeValue = typeof body.challenge === 'string' ? body.challenge : '';
    const pending = challenges.get(challengeValue);
    challenges.delete(challengeValue);
    if (!pending || pending.origin !== origin || pending.expiresAt < now()) {
      throw new HttpError(401, 'INVALID_PAIRING_CHALLENGE', 'Pairing challenge is invalid or expired');
    }
    const extensionId = origin.slice('chrome-extension://'.length);
    const extensionToken = token();
    const name = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 80)
      : `Chrome extension ${extensionId.slice(0, 8)}`;
    const paired = {
      id: extensionId,
      name,
      origin,
      tokenHash: tokenHash(extensionToken),
      createdAt: new Date(now()).toISOString()
    };
    config = await configStore.update((draft) => {
      draft.extensions = draft.extensions.filter((item) => item.origin !== origin);
      draft.extensions.push(paired);
    });
    sendJson(response, 201, { extension: publicExtension(paired), token: extensionToken }, cors);
  }

  async function route(request, response) {
    if (!isLoopbackRequestHost(request.headers.host)) {
      throw new HttpError(421, 'INVALID_HOST', 'Manager accepts loopback Host headers only');
    }
    const url = new URL(request.url, `http://${request.headers.host}`);
    const cors = currentCors(request);
    if (request.method === 'OPTIONS') {
      if (!requestOrigin(request)) {
        throw new HttpError(400, 'ORIGIN_REQUIRED', 'CORS preflight requires Origin');
      }
      sendEmpty(response, 204, cors);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/health') {
      sendJson(response, 200, {
        ok: true,
        service: MANAGER_NAME,
        version: VERSION,
        apiVersion: API_VERSION,
        host,
        port: listeningAddress?.port ?? port,
        pid: process.pid,
        startedAt
      }, cors);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/pair/challenge') {
      const origin = requestOrigin(request);
      if (!isChromeExtensionOrigin(origin)) {
        throw new HttpError(403, 'EXTENSION_ORIGIN_REQUIRED', 'Chrome extension origin is required');
      }
      for (const [value, pending] of challenges) {
        if (pending.expiresAt < now() || pending.origin === origin) challenges.delete(value);
      }
      const challenge = token();
      challenges.set(challenge, { origin, expiresAt: now() + PAIRING_CHALLENGE_TTL_MS });
      sendJson(response, 200, { challenge, expiresInMs: PAIRING_CHALLENGE_TTL_MS }, cors);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/pair/extension') {
      await pairExtension(request, response, cors);
      return;
    }

    if (request.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
      await serveStatic(response, dashboardDir, 'index.html');
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/dashboard/')) {
      await serveStatic(response, dashboardDir, url.pathname.slice('/dashboard/'.length));
      return;
    }

    const profileMatch = /^\/v1\/profiles\/([^/]+)$/.exec(url.pathname);
    const profileActionMatch = /^\/v1\/profiles\/([^/]+)\/(open|close|session)$/.exec(url.pathname);
    const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
    const taskActionMatch = /^\/v1\/tasks\/([^/]+)\/(cancel)$/.exec(url.pathname);

    if (request.method === 'GET' && url.pathname === '/v1/profiles') {
      await authenticate(request);
      const profiles = (await profileStore.list()).map(publicProfile);
      sendJson(response, 200, { profiles }, cors);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/profiles') {
      await authenticate(request);
      const profile = await profileStore.create(validateProfileCreate(await readJson(request)));
      sendJson(response, 201, { profile: publicProfile(profile) }, cors);
      return;
    }
    if (profileMatch && request.method === 'PATCH') {
      await authenticate(request);
      const profileId = decodeURIComponent(profileMatch[1]);
      const profile = await profileStore.update(
        profileId,
        validateProfilePatch(await readJson(request, { maxBytes: 32 * 1024 }))
      );
      sendJson(response, 200, { profile: publicProfile(profile) }, cors);
      return;
    }
    if (profileMatch && request.method === 'DELETE') {
      await authenticate(request);
      const profileId = decodeURIComponent(profileMatch[1]);
      const removed = await profileStore.remove(profileId);
      sendJson(response, 200, { removed: publicProfile(removed) }, cors);
      return;
    }
    if (profileActionMatch && request.method === 'POST') {
      const profileId = decodeURIComponent(profileActionMatch[1]);
      const actionName = profileActionMatch[2];
      const auth = await authenticate(request, { extensionOnly: actionName === 'session' });
      if (actionName === 'session') {
        const bundle = validatedSessionBundle(await readJson(request), auth.extension);
        const importSession = requireTaskMethod(taskService, 'importSession');
        await profileStore.get(profileId);
        let result;
        try {
          result = await importSession(profileId, bundle);
        } catch (error) {
          throw new HttpError(
            Number.isInteger(error?.statusCode) ? error.statusCode : 500,
            typeof error?.code === 'string' ? error.code : 'SESSION_IMPORT_FAILED',
            'Session import failed'
          );
        }
        sendJson(response, 200, safeSessionResult(profileId, result), cors);
        return;
      }

      if (actionName === 'open') {
        await profileStore.recoverExpiredLeases();
        await profileStore.get(profileId);
        const openProfile = requireTaskMethod(taskService, 'openProfile');
        await openProfile(profileId);
        sendJson(response, 200, { profile: publicProfile(await profileStore.get(profileId)) }, cors);
        return;
      }

      await profileStore.get(profileId);
      const closeProfile = requireTaskMethod(taskService, 'closeProfile');
      await closeProfile(profileId);
      sendJson(response, 200, { profile: publicProfile(await profileStore.get(profileId)) }, cors);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/tasks') {
      await authenticate(request);
      const tasks = await requireTaskMethod(taskService, 'list')();
      sendJson(response, 200, { tasks: tasks.map(publicTask) }, cors);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/tasks') {
      await authenticate(request);
      const task = await requireTaskMethod(taskService, 'create')(await readJson(request));
      sendJson(response, 202, { task: publicTask(task) }, cors);
      return;
    }
    if (taskMatch && request.method === 'GET') {
      await authenticate(request);
      const task = await requireTaskMethod(taskService, 'get')(decodeURIComponent(taskMatch[1]));
      sendJson(response, 200, { task: publicTask(task) }, cors);
      return;
    }
    if (taskActionMatch && request.method === 'POST') {
      await authenticate(request);
      const task = await requireTaskMethod(taskService, 'cancel')(decodeURIComponent(taskActionMatch[1]));
      sendJson(response, 200, { task: publicTask(task) }, cors);
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'Route was not found');
  }

  async function handle(request, response) {
    try {
      await route(request, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      let cors = {};
      try {
        cors = currentCors(request);
      } catch {
        // Do not grant CORS access to rejected origins.
      }
      const normalized = errorResponse(error);
      sendJson(response, normalized.statusCode, normalized.body, cors);
    }
  }

  async function start() {
    if (server?.listening) return api;
    server = http.createServer((request, response) => void handle(request, response));
    await new Promise((resolveStart, rejectStart) => {
      const onError = (error) => {
        server.off('listening', onListening);
        rejectStart(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolveStart();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    listeningAddress = server.address();
    startedAt = new Date(now()).toISOString();
    return api;
  }

  async function stop() {
    if (!server?.listening) return;
    let serviceError;
    try {
      await taskService.close?.();
    } catch (error) {
      serviceError = error;
    } finally {
      await new Promise((resolveStop, rejectStop) => {
        server.close((error) => error ? rejectStop(error) : resolveStop());
        server.closeAllConnections?.();
      });
      listeningAddress = undefined;
    }
    if (serviceError) throw serviceError;
  }

  const api = {
    host,
    requestedPort: port,
    dataDir: resolvedDataDir,
    dashboardDir,
    token: config.managerToken,
    profileStore,
    configStore,
    taskService,
    stateDir,
    start,
    stop,
    address() {
      return listeningAddress;
    },
    get baseUrl() {
      return listeningAddress ? `http://${host}:${listeningAddress.port}` : null;
    },
    get dashboardUrl() {
      return listeningAddress
        ? `http://${host}:${listeningAddress.port}/dashboard#token=${encodeURIComponent(config.managerToken)}`
        : null;
    }
  };
  return api;
}

export async function startManager(options) {
  const manager = await createManager(options);
  await manager.start();
  return manager;
}
