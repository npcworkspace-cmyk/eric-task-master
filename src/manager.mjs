import http from 'node:http';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { JsonStore } from './lib/json-store.mjs';
import { ManagerLock } from './lib/manager-lock.mjs';
import {
  createManagerIdentityProof,
  generateManagerIdentity,
  MANAGER_SERVICE,
  validateIdentityNonce,
  validateManagerIdentity
} from './lib/manager-identity.mjs';
import { ProfileStore, ProfileStoreError } from './lib/profile-store.mjs';
import { redactSensitiveText, redactSensitiveValue } from './lib/redaction.mjs';
import { isReservedAgentClientId } from './lib/principal.mjs';
import {
  HttpError,
  corsHeaders,
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

const DASHBOARD_APPROVAL_TTL_MS = 2 * 60_000;
const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60_000;
const MANAGER_NAME = MANAGER_SERVICE;
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RESUME_NOTICE = 'Resume is explicit: the task module must inspect its checkpoint and current site state before repeating any action whose external outcome is unknown.';
const AGENT_TOKEN_VERSION = 'ETMA1';

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

function agentToken(managerToken, clientId) {
  const encodedClientId = Buffer.from(clientId, 'utf8').toString('base64url');
  const signature = createHmac('sha256', managerToken)
    .update(`${AGENT_TOKEN_VERSION}\0${clientId}`, 'utf8')
    .digest('base64url');
  return `${AGENT_TOKEN_VERSION}.${encodedClientId}.${signature}`;
}

function authenticateAgentToken(value, managerToken) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== AGENT_TOKEN_VERSION) return null;
  let clientId;
  try {
    clientId = Buffer.from(parts[1], 'base64url').toString('utf8');
    if (Buffer.from(clientId, 'utf8').toString('base64url') !== parts[1]) return null;
    validateClientId(clientId);
  } catch {
    return null;
  }
  return secureEqual(value, agentToken(managerToken, clientId)) ? clientId : null;
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

function publicAgent(agent) {
  return { clientId: agent.clientId, name: agent.name };
}

function validateClientId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) {
    throw new HttpError(
      400,
      'INVALID_CLIENT_ID',
      'clientId must contain 1-128 letters, numbers, dots, underscores, colons, or hyphens'
    );
  }
  if (isReservedAgentClientId(value)) {
    throw new HttpError(
      400,
      'RESERVED_CLIENT_ID',
      'clientId uses a reserved internal principal name'
    );
  }
  return value;
}

function requireRole(auth, ...roles) {
  if (!roles.includes(auth?.role)) {
    throw new HttpError(403, 'ROLE_FORBIDDEN', 'This credential cannot perform the requested operation');
  }
  return auth;
}

function serviceCaller(auth) {
  return auth?.role === 'dashboard'
    ? { role: 'manager-admin', clientId: 'dashboard' }
    : auth;
}

function canUseProfile(profile, auth) {
  if (['manager-admin', 'dashboard'].includes(auth?.role)) return true;
  return auth?.role === 'agent' && (
    profile?.ownerClientId === auth.clientId || profile?.access === 'shared'
  );
}

function canManageProfile(profile, auth) {
  if (['manager-admin', 'dashboard'].includes(auth?.role)) return true;
  return auth?.role === 'agent' && profile?.ownerClientId === auth.clientId;
}

function requireProfileAccess(profile, auth, { manage = false } = {}) {
  const allowed = manage ? canManageProfile(profile, auth) : canUseProfile(profile, auth);
  if (!allowed) {
    throw new HttpError(403, 'PROFILE_ACCESS_DENIED', 'This Agent is not authorized to use this Profile');
  }
  return profile;
}

function validateProfilePatch(body) {
  const allowed = new Set(['name', 'defaultBehavior', 'headless', 'browserChannel', 'access']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new HttpError(400, 'INVALID_PROFILE_PATCH', `Unsupported fields: ${unknown.join(', ')}`);
  }
  return body;
}

function validateProfileCreate(body) {
  const allowed = new Set(['name', 'kind', 'defaultBehavior', 'headless', 'browserChannel', 'access']);
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

function errorResponse(error) {
  if (error instanceof HttpError || error instanceof ProfileStoreError) {
    const message = redactSensitiveText(error.message);
    const details = error.details === undefined
      ? undefined
      : redactSensitiveValue(error.details);
    return {
      statusCode: error.statusCode,
      body: {
        code: error.code,
        message,
        error: {
          code: error.code,
          message,
          ...(details === undefined ? {} : { details })
        }
      }
    };
  }
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600) {
    const message = redactSensitiveText(
      typeof error.message === 'string' ? error.message : 'Request failed'
    );
    return {
      statusCode: error.statusCode,
      body: {
        code: typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
        message,
        error: {
          code: typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
          message
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
  profileProcessAlive,
  allowedTaskRoots = [resolve(MODULE_DIRECTORY, '..')]
} = {}) {
  assertLoopbackHost(host);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('port must be an integer from 0 to 65535');
  }
  const resolvedDataDir = resolve(dataDir);
  const managerLock = new ManagerLock(join(resolvedDataDir, '.manager.lock'));
  await managerLock.acquire();
  try {
  const configStore = new JsonStore(join(resolvedDataDir, 'config.json'), () => ({
    version: 1,
    managerToken: token(),
    managerIdentity: generateManagerIdentity(),
    createdAt: new Date(now()).toISOString(),
    agents: []
  }));
  await configStore.init();
  let config = await configStore.read();
  if (config.managerIdentity === undefined) {
    config = await configStore.update((draft) => {
      draft.managerIdentity = generateManagerIdentity();
    });
  }
  const managerIdentity = validateManagerIdentity(config.managerIdentity);
  if (typeof config.managerToken !== 'string' || config.managerToken.length < 32) {
    config = await configStore.update((draft) => {
      draft.managerToken = token();
    });
  }
  if (config.extensions !== undefined) {
    config = await configStore.update((draft) => {
      delete draft.extensions;
    });
  }
  // Scoped Agent bearers are stateless and stable per registered host. Clear
  // the legacy registry so concurrent MCP processes cannot evict one another
  // or grow config.json until bootstrap fails.
  if (!Array.isArray(config.agents) || config.agents.length !== 0 || config.agentCredentialVersion !== 1) {
    config = await configStore.update((draft) => {
      draft.agents = [];
      draft.agentCredentialVersion = 1;
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
  const taskInboxRoot = join(resolvedDataDir, 'task-inbox');
  await mkdir(taskInboxRoot, { recursive: true, mode: 0o700 });
  const createdTaskService = suppliedTaskService === undefined && typeof taskServiceFactory === 'function'
    ? await taskServiceFactory({
      profileStore,
      stateDir,
      taskTypesFile: join(resolvedDataDir, 'task-types.json'),
      taskTypesRoot: join(resolvedDataDir, 'task-types'),
      allowedTaskRoots: [...allowedTaskRoots, taskInboxRoot]
    })
    : suppliedTaskService;
  const taskService = normalizeTaskService(createdTaskService);
  const dashboardApprovals = new Map();
  const dashboardSessions = new Map();
  let server;
  let startedAt;
  let listeningAddress;
  let stopped = false;
  let stopping = false;
  let stopPromise;
  let activeOperations = 0;
  const drainWaiters = new Set();
  let acceptedShutdownRequest;
  let shutdownRequestPublished = false;
  let resolveShutdownRequested;
  const shutdownRequested = new Promise((resolveShutdown) => {
    resolveShutdownRequested = resolveShutdown;
  });

  function publishShutdownRequest(request) {
    if (shutdownRequestPublished) return;
    shutdownRequestPublished = true;
    resolveShutdownRequested(request);
  }

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
    if (sameManager) return corsHeaders(origin);
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
  }

  async function authenticate(request) {
    const bearer = parseBearer(request);
    if (!bearer) throw new HttpError(401, 'AUTH_REQUIRED', 'Bearer token is required');
    if (secureEqual(bearer, config.managerToken)) {
      return { role: 'manager-admin', clientId: 'manager-admin' };
    }
    const agentClientId = authenticateAgentToken(bearer, config.managerToken);
    if (agentClientId) {
      return { role: 'agent', clientId: agentClientId };
    }
    const hashed = tokenHash(bearer);
    const dashboard = dashboardSessions.get(hashed);
    if (dashboard) {
      if (dashboard.expiresAt <= now()) {
        dashboardSessions.delete(hashed);
      } else {
        return { role: 'dashboard', clientId: dashboard.clientId };
      }
    }
    throw new HttpError(401, 'INVALID_TOKEN', 'Bearer token is invalid');
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
      const counts = typeof taskService.schedulerStatus === 'function'
        ? await taskService.schedulerStatus()
        : undefined;
      sendJson(response, 200, {
        ok: true,
        service: MANAGER_NAME,
        version: VERSION,
        apiVersion: API_VERSION,
        host,
        port: listeningAddress?.port ?? port,
        pid: process.pid,
        startedAt,
        state: stopping ? 'stopping' : 'ready',
        identityFingerprint: managerIdentity.fingerprint,
        ...(counts ? { counts } : {})
      }, cors);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/identity/challenge') {
      const body = await readJson(request, { maxBytes: 4 * 1024 });
      let nonce;
      try {
        nonce = validateIdentityNonce(body.nonce);
      } catch {
        throw new HttpError(400, 'INVALID_IDENTITY_NONCE', 'A 256-bit base64url nonce is required');
      }
      sendJson(response, 200, createManagerIdentityProof(managerIdentity, {
        service: MANAGER_NAME,
        version: VERSION,
        apiVersion: API_VERSION,
        host,
        port: listeningAddress?.port ?? port,
        nonce
      }), cors);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/manager/shutdown') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin');
      await readJson(request, { maxBytes: 4 * 1024 });
      acceptedShutdownRequest ??= {
        requestedAt: new Date(now()).toISOString(),
        requestedBy: auth.clientId
      };
      stopping = true;
      sendJson(response, 202, {
        ok: true,
        accepted: true,
        state: 'stopping',
        pid: process.pid,
        identityFingerprint: managerIdentity.fingerprint,
        requestedAt: acceptedShutdownRequest.requestedAt
      }, cors);
      return { shutdownRequest: acceptedShutdownRequest };
    }

    if (request.method === 'POST' && url.pathname === '/v1/agents/issue') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin');
      const body = await readJson(request, { maxBytes: 16 * 1024 });
      const clientId = validateClientId(body.clientId);
      const name = typeof body.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 80)
        : clientId;
      const scopedToken = agentToken(config.managerToken, clientId);
      const agent = {
        clientId,
        name
      };
      sendJson(response, 201, { agentToken: scopedToken, agent: publicAgent(agent) }, cors);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/dashboard/authorize') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin');
      await readJson(request, { maxBytes: 4 * 1024 });
      for (const [code, approval] of dashboardApprovals) {
        if (approval.expiresAt <= now()) dashboardApprovals.delete(code);
      }
      while (dashboardApprovals.size >= 8) dashboardApprovals.delete(dashboardApprovals.keys().next().value);
      const code = randomBytes(24).toString('base64url');
      dashboardApprovals.set(code, {
        expiresAt: now() + DASHBOARD_APPROVAL_TTL_MS,
        clientId: `dashboard:${auth.clientId}`
      });
      sendJson(response, 201, { code, expiresInMs: DASHBOARD_APPROVAL_TTL_MS }, cors);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/dashboard/session') {
      const body = await readJson(request, { maxBytes: 4 * 1024 });
      const code = typeof body.code === 'string' ? body.code : '';
      const approval = dashboardApprovals.get(code);
      dashboardApprovals.delete(code);
      if (!approval || approval.expiresAt <= now()) {
        throw new HttpError(401, 'INVALID_DASHBOARD_CODE', 'Dashboard authorization code is invalid or expired');
      }
      for (const [hash, session] of dashboardSessions) {
        if (session.expiresAt <= now()) dashboardSessions.delete(hash);
      }
      while (dashboardSessions.size >= 8) dashboardSessions.delete(dashboardSessions.keys().next().value);
      const dashboardToken = token();
      dashboardSessions.set(tokenHash(dashboardToken), {
        expiresAt: now() + DASHBOARD_SESSION_TTL_MS,
        clientId: approval.clientId
      });
      sendJson(response, 201, {
        dashboardToken,
        expiresInMs: DASHBOARD_SESSION_TTL_MS
      }, cors);
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
    const profileActionMatch = /^\/v1\/profiles\/([^/]+)\/(open|close)$/.exec(url.pathname);
    const taskTypeMatch = /^\/v1\/task-types\/([^/]+)$/.exec(url.pathname);
    const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
    const taskActionMatch = /^\/v1\/tasks\/([^/]+)\/(cancel|resume|continue)$/.exec(url.pathname);
    const taskArtifactsMatch = /^\/v1\/tasks\/([^/]+)\/artifacts$/.exec(url.pathname);
    const taskArtifactMatch = /^\/v1\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);

    if (request.method === 'GET' && url.pathname === '/v1/profiles') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const profiles = (await profileStore.list())
        .filter((profile) => canUseProfile(profile, auth))
        .map(publicProfile);
      sendJson(response, 200, { profiles }, cors);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/profiles') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const requested = validateProfileCreate(await readJson(request));
      const { access, ...profileInput } = requested;
      const profile = await profileStore.create(profileInput, {
        ownerClientId: auth.role === 'agent' ? auth.clientId : null,
        access: access ?? (auth.role === 'agent' ? 'private' : 'shared')
      });
      sendJson(response, 201, { profile: publicProfile(profile) }, cors);
      return;
    }
    if (profileMatch && request.method === 'PATCH') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const profileId = decodeURIComponent(profileMatch[1]);
      requireProfileAccess(await profileStore.get(profileId), auth, { manage: true });
      const profile = await profileStore.update(
        profileId,
        validateProfilePatch(await readJson(request, { maxBytes: 32 * 1024 }))
      );
      sendJson(response, 200, { profile: publicProfile(profile) }, cors);
      return;
    }
    if (profileMatch && request.method === 'DELETE') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'dashboard');
      const profileId = decodeURIComponent(profileMatch[1]);
      const removed = await profileStore.remove(profileId);
      sendJson(response, 200, { removed: publicProfile(removed) }, cors);
      return;
    }
    if (profileActionMatch && request.method === 'POST') {
      const profileId = decodeURIComponent(profileActionMatch[1]);
      const actionName = profileActionMatch[2];
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      requireProfileAccess(await profileStore.get(profileId), auth);

      if (actionName === 'open') {
        await profileStore.recoverExpiredLeases();
        const openProfile = requireTaskMethod(taskService, 'openProfile');
        await openProfile(profileId, serviceCaller(auth));
        sendJson(response, 200, { profile: publicProfile(await profileStore.get(profileId)) }, cors);
        return;
      }

      const closeProfile = requireTaskMethod(taskService, 'closeProfile');
      await closeProfile(profileId, serviceCaller(auth));
      sendJson(response, 200, { profile: publicProfile(await profileStore.get(profileId)) }, cors);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/task-types') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const result = await requireTaskMethod(taskService, 'listTaskTypes')({
        query: url.searchParams.get('query') || '',
        domain: url.searchParams.get('domain') || '',
        intent: url.searchParams.get('intent') || ''
      }, serviceCaller(auth));
      sendJson(response, 200, result, cors);
      return;
    }
    if (taskTypeMatch && request.method === 'GET') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const taskType = await requireTaskMethod(taskService, 'describeTaskType')(
        decodeURIComponent(taskTypeMatch[1]),
        serviceCaller(auth)
      );
      sendJson(response, 200, { taskType }, cors);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/task-types/install') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin');
      const installed = await requireTaskMethod(taskService, 'installTaskType')(
        await readJson(request, { maxBytes: 32 * 1024 }),
        auth
      );
      sendJson(response, 201, { taskType: installed }, cors);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/task-packs/install') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin');
      const installed = await requireTaskMethod(taskService, 'installTaskPack')(
        await readJson(request, { maxBytes: 256 * 1024 }),
        auth
      );
      sendJson(response, 201, { taskPack: installed }, cors);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/tasks') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      const cursor = url.searchParams.get('cursor');
      const result = await requireTaskMethod(taskService, 'list')({ caller: serviceCaller(auth), limit, cursor });
      const page = Array.isArray(result) ? { tasks: result, nextCursor: null } : result;
      sendJson(response, 200, {
        tasks: page.tasks.map(publicTask),
        nextCursor: page.nextCursor ?? null
      }, cors);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/tasks') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent');
      const task = await requireTaskMethod(taskService, 'create')(await readJson(request), auth);
      sendJson(response, 202, { task: publicTask(task) }, cors);
      return;
    }
    if (taskArtifactsMatch && request.method === 'GET') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const artifacts = await requireTaskMethod(taskService, 'listArtifacts')(
        decodeURIComponent(taskArtifactsMatch[1]),
        serviceCaller(auth)
      );
      sendJson(response, 200, { artifacts }, cors);
      return;
    }
    if (taskArtifactMatch && request.method === 'GET') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const rawOffset = url.searchParams.get('offset');
      const rawMaxBytes = url.searchParams.get('maxBytes');
      const artifact = await requireTaskMethod(taskService, 'readArtifact')(
        decodeURIComponent(taskArtifactMatch[1]),
        decodeURIComponent(taskArtifactMatch[2]),
        {
          offset: rawOffset === null ? 0 : Number(rawOffset),
          maxBytes: rawMaxBytes === null ? 48 * 1024 : Number(rawMaxBytes)
        },
        serviceCaller(auth)
      );
      sendJson(response, 200, artifact, cors);
      return;
    }
    if (taskMatch && request.method === 'GET') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const task = await requireTaskMethod(taskService, 'get')(decodeURIComponent(taskMatch[1]), serviceCaller(auth));
      sendJson(response, 200, { task: publicTask(task) }, cors);
      return;
    }
    if (taskActionMatch && request.method === 'POST') {
      const auth = await authenticate(request);
      const taskId = decodeURIComponent(taskActionMatch[1]);
      if (taskActionMatch[2] === 'resume') {
        requireRole(auth, 'manager-admin', 'agent');
        const task = await requireTaskMethod(taskService, 'resume')(
          taskId,
          await readJson(request, { maxBytes: 4 * 1024 }),
          serviceCaller(auth)
        );
        sendJson(response, 202, { task: publicTask(task), notice: RESUME_NOTICE }, cors);
        return;
      }
      if (taskActionMatch[2] === 'continue') {
        requireRole(auth, 'manager-admin', 'agent', 'dashboard');
        const task = await requireTaskMethod(taskService, 'continueTask')(
          taskId,
          await readJson(request, { maxBytes: 4 * 1024 }),
          serviceCaller(auth)
        );
        sendJson(response, 202, { task: publicTask(task) }, cors);
        return;
      }
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const task = await requireTaskMethod(taskService, 'cancel')(taskId, serviceCaller(auth));
      sendJson(response, 200, { task: publicTask(task) }, cors);
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'Route was not found');
  }

  async function handle(request, response) {
    let healthRequest = false;
    let identityRequest = false;
    let shutdownRequest = false;
    let acceptedShutdown;
    try {
      const requestUrl = new URL(request.url, `http://${request.headers.host}`);
      healthRequest = request.method === 'GET' && requestUrl.pathname === '/v1/health';
      identityRequest = request.method === 'POST' && requestUrl.pathname === '/v1/identity/challenge';
      shutdownRequest = request.method === 'POST' && requestUrl.pathname === '/v1/manager/shutdown';
    } catch {
      // Normal routing returns the bounded invalid-host/request error.
    }
    if (!healthRequest) activeOperations += 1;
    try {
      if (stopping && !healthRequest && !identityRequest && !shutdownRequest) {
        throw new HttpError(503, 'SERVICE_CLOSING', 'Manager is stopping and accepts no new operations');
      }
      const outcome = await route(request, response);
      acceptedShutdown = outcome?.shutdownRequest;
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
    } finally {
      if (!healthRequest) {
        activeOperations -= 1;
        if (activeOperations === 0) {
          for (const resolveDrain of drainWaiters) resolveDrain();
          drainWaiters.clear();
        }
      }
      if (acceptedShutdown) {
        const publish = () => setImmediate(() => publishShutdownRequest(acceptedShutdown));
        if (response.writableFinished) publish();
        else {
          response.once('finish', publish);
          response.once('close', publish);
        }
      }
    }
  }

  async function waitForActiveOperations() {
    if (activeOperations === 0) return;
    await new Promise((resolveDrain) => drainWaiters.add(resolveDrain));
  }

  async function start() {
    if (server?.listening) return api;
    if (stopped) throw new Error('Manager instance has already been stopped');
    server = http.createServer((request, response) => void handle(request, response));
    try {
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
    } catch (error) {
      stopped = true;
      await managerLock.release().catch(() => {});
      throw error;
    }
    listeningAddress = server.address();
    startedAt = new Date(now()).toISOString();
    return api;
  }

  async function stop() {
    if (stopped) return;
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      let serviceError;
      let serverError;
      try {
        await waitForActiveOperations();
        await taskService.close?.();
      } catch (error) {
        serviceError = error;
      } finally {
        try {
          if (server?.listening) {
            await new Promise((resolveStop, rejectStop) => {
              server.close((error) => error ? rejectStop(error) : resolveStop());
              server.closeAllConnections?.();
            });
          }
        } catch (error) {
          serverError = error;
        } finally {
          listeningAddress = undefined;
          stopped = true;
          await managerLock.release().catch(() => {});
        }
      }
      if (serviceError) throw serviceError;
      if (serverError) throw serverError;
    })();
    return stopPromise;
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
    shutdownRequested,
    address() {
      return listeningAddress;
    },
    get baseUrl() {
      return listeningAddress ? `http://${host}:${listeningAddress.port}` : null;
    },
    get dashboardUrl() {
      return listeningAddress
        ? `http://${host}:${listeningAddress.port}/dashboard`
        : null;
    }
  };
  return api;
  } catch (error) {
    await managerLock.release().catch(() => {});
    throw error;
  }
}

export async function startManager(options) {
  const manager = await createManager(options);
  await manager.start();
  return manager;
}
