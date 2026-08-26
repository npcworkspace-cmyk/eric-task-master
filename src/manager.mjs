import http from 'node:http';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AgentTokenError,
  authenticateAgentToken,
  issueAgentToken,
  validateAgentClientId
} from './lib/agent-token.mjs';
import { AgentRegistry, AgentRegistryError } from './lib/agent-registry.mjs';
import { JsonStore } from './lib/json-store.mjs';
import {
  DASHBOARD_SESSION_TTL_MS,
  DashboardSessionStore
} from './lib/dashboard-session-store.mjs';
import { ManagerLock } from './lib/manager-lock.mjs';
import {
  createManagerIdentityProof,
  generateManagerIdentity,
  MANAGER_SERVICE,
  validateIdentityNonce,
  validateManagerIdentity
} from './lib/manager-identity.mjs';
import { ProfileStore, ProfileStoreError } from './lib/profile-store.mjs';
import { redactPublicText, redactPublicValue } from './lib/redaction.mjs';
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
const MAX_DASHBOARD_APPROVALS = 512;
const DASHBOARD_COOKIE = 'taskmaster_owner';
const MANAGER_NAME = MANAGER_SERVICE;
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RESUME_NOTICE = 'Resume is explicit: the task module must inspect its checkpoint and current site state before repeating any action whose external outcome is unknown.';

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
  try {
    return validateAgentClientId(value);
  } catch (error) {
    if (error instanceof AgentTokenError) {
      throw new HttpError(400, error.code, error.message);
    }
    throw error;
  }
}

function validateTaskCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_TASK_CREATE', 'Task request must be an object');
  }
  const allowed = new Set(['profileId', 'taskType', 'taskLabel', 'input', 'timeoutMs', 'idempotencyKey']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new HttpError(400, 'INVALID_TASK_CREATE', `Unsupported task fields: ${unknown.join(', ')}`);
  }
  return body;
}

function requireRole(auth, ...roles) {
  if (!roles.includes(auth?.role)) {
    throw new HttpError(403, 'ROLE_FORBIDDEN', 'This credential cannot perform the requested operation');
  }
  return auth;
}

function serviceCaller(auth) {
  return auth?.role === 'dashboard'
    ? { role: 'manager-admin', clientId: 'manager-admin' }
    : auth;
}

function parseCookie(request, name) {
  const source = request.headers.cookie;
  if (typeof source !== 'string' || source.length > 16 * 1024) return null;
  for (const item of source.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1 || item.slice(0, separator).trim() !== name) continue;
    const value = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

function ownerCookie(value, { clear = false } = {}) {
  const maxAge = clear ? 0 : Math.floor(DASHBOARD_SESSION_TTL_MS / 1000);
  return `${DASHBOARD_COOKIE}=${clear ? '' : encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function canUseProfile(profile, auth) {
  void profile;
  const caller = serviceCaller(auth);
  return caller?.role === 'manager-admin' || caller?.role === 'agent';
}

function canManageProfile(profile, auth) {
  return canUseProfile(profile, auth);
}

function requireProfileAccess(profile, auth, { manage = false } = {}) {
  const allowed = manage ? canManageProfile(profile, auth) : canUseProfile(profile, auth);
  if (!allowed) {
    throw new HttpError(403, 'PROFILE_ACCESS_DENIED', 'This Agent is not authorized to use this Profile');
  }
  return profile;
}

function validateProfilePatch(body) {
  const allowed = new Set(['name', 'defaultBehavior', 'headless', 'access']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new HttpError(400, 'INVALID_PROFILE_PATCH', `Unsupported fields: ${unknown.join(', ')}`);
  }
  return body;
}

function validateProfileCreate(body) {
  const allowed = new Set(['name', 'kind', 'defaultBehavior', 'headless', 'browserEngine', 'access']);
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
  if (error instanceof HttpError || error instanceof ProfileStoreError || error instanceof AgentRegistryError || error instanceof AgentTokenError) {
    const message = redactPublicText(error.message);
    const details = error.details === undefined
      ? undefined
      : redactPublicValue(error.details);
    return {
      statusCode: error.statusCode ?? 400,
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
    const message = redactPublicText(
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
  if (!Array.isArray(config.agents) || config.agents.length !== 0 || config.agentCredentialVersion !== 2) {
    config = await configStore.update((draft) => {
      draft.agents = [];
      draft.agentCredentialVersion = 2;
    });
  }

  const agentRegistry = new AgentRegistry({
    filePath: join(resolvedDataDir, 'agents.json'),
    now
  });
  await agentRegistry.init();
  const agentTouchAt = new Map();

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
  const dashboardSessions = new DashboardSessionStore({
    filePath: join(resolvedDataDir, 'dashboard-sessions.json'),
    now
  });
  await dashboardSessions.init();
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

  function managerOrigin() {
    if (!listeningAddress) {
      throw new HttpError(503, 'MANAGER_NOT_LISTENING', 'Manager is not listening yet');
    }
    return `http://${host}:${listeningAddress.port}`;
  }

  function dashboardLink(code, focusTaskId = null) {
    const dashboard = new URL('/dashboard', managerOrigin());
    if (focusTaskId) dashboard.searchParams.set('task', focusTaskId);
    dashboard.hash = new URLSearchParams({ code }).toString();
    return dashboard.href;
  }

  async function createDashboardApproval(principal, focusTaskId = null) {
    if (!['manager-admin', 'agent'].includes(principal?.role)) {
      throw new HttpError(403, 'ROLE_FORBIDDEN', 'This credential cannot authorize a Dashboard');
    }
    if (focusTaskId !== null) {
      if (typeof focusTaskId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(focusTaskId)) {
        throw new HttpError(400, 'INVALID_TASK_ID', 'focusTaskId must be a stable task identifier');
      }
      await requireTaskMethod(taskService, 'get')(focusTaskId, principal);
    }
    for (const [code, approval] of dashboardApprovals) {
      if (approval.expiresAt <= now()) dashboardApprovals.delete(code);
    }
    while (dashboardApprovals.size >= MAX_DASHBOARD_APPROVALS) {
      dashboardApprovals.delete(dashboardApprovals.keys().next().value);
    }
    const code = randomBytes(24).toString('base64url');
    dashboardApprovals.set(code, {
      expiresAt: now() + DASHBOARD_APPROVAL_TTL_MS,
      focusTaskId
    });
    return {
      code,
      dashboardUrl: dashboardLink(code, focusTaskId),
      expiresInMs: DASHBOARD_APPROVAL_TTL_MS
    };
  }

  async function currentAgentActivity() {
    if (typeof taskService.list !== 'function') return new Map();
    const page = await taskService.list({
      caller: { role: 'manager-admin', clientId: 'manager-admin' },
      limit: 100,
      cursor: null
    });
    const tasks = Array.isArray(page) ? page : page?.tasks ?? [];
    const activity = new Map();
    for (const task of tasks) {
      const clientId = task?.ownerRole === 'agent'
        ? task.ownerClientId
        : task?.agent?.clientId;
      if (typeof clientId !== 'string') continue;
      const current = activity.get(clientId) ?? {
        working: false,
        currentTaskIds: [],
        currentProfileIds: [],
        queueDepth: 0
      };
      if (!['completed', 'failed', 'cancelled'].includes(task.state)) {
        current.working = true;
        current.currentTaskIds.push(task.id);
        if (task.profileId) current.currentProfileIds.push(task.profileId);
        if (task.state === 'queued') current.queueDepth += 1;
      }
      activity.set(clientId, current);
    }
    return activity;
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
    if (bearer) {
      if (secureEqual(bearer, config.managerToken)) {
        return { role: 'manager-admin', clientId: 'manager-admin' };
      }
      const agent = authenticateAgentToken(bearer, config.managerToken);
      if (agent) {
        if (await agentRegistry.isRevoked(agent.clientId)) {
          throw new HttpError(403, 'AGENT_REVOKED', 'This Agent has been revoked in the Owner Console');
        }
        const lastTouch = agentTouchAt.get(agent.clientId) ?? 0;
        if (now() - lastTouch >= 10_000) {
          await agentRegistry.touch(agent.clientId, {
            name: agent.name,
            connectionId: request.headers['x-taskmaster-connection-id']
          });
          agentTouchAt.set(agent.clientId, now());
        }
        return { role: 'agent', clientId: agent.clientId, agentName: agent.name };
      }
    }
    const cookie = parseCookie(request, DASHBOARD_COOKIE);
    const dashboard = cookie ? await dashboardSessions.authenticate(cookie) : null;
    if (dashboard) {
      const auth = {
        role: 'dashboard',
        principal: { role: 'manager-admin', clientId: 'manager-admin' },
        sessionId: dashboard.id,
        focusTaskId: dashboard.focusTaskId ?? null
      };
      requireDashboardMutationOrigin(request, auth);
      return auth;
    }
    throw new HttpError(401, bearer ? 'INVALID_TOKEN' : 'AUTH_REQUIRED', 'A valid Manager, Agent, or Owner session is required');
  }

  function requireDashboardMutationOrigin(request, auth) {
    if (auth?.role !== 'dashboard' || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = requestOrigin(request);
    if (!origin || origin !== managerOrigin()) {
      throw new HttpError(403, 'DASHBOARD_ORIGIN_REQUIRED', 'Owner Console mutations require the exact Manager origin');
    }
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
      validateClientId(body.clientId);
      const registered = await agentRegistry.register({
        clientId: body.clientId,
        name: body.name,
        connectionId: body.connectionId ?? request.headers['x-taskmaster-connection-id']
      });
      let issued;
      try {
        issued = issueAgentToken(config.managerToken, { clientId: body.clientId, name: body.name });
      } catch (error) {
        if (error instanceof AgentTokenError) {
          throw new HttpError(400, error.code, error.message);
        }
        throw error;
      }
      sendJson(response, 201, {
        agentToken: issued.token,
        agent: { ...publicAgent(issued.agent), agentId: registered.agentId, displayName: registered.displayName }
      }, cors);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/dashboard/authorize') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent');
      const body = await readJson(request, { maxBytes: 4 * 1024 });
      const unknown = Object.keys(body).filter((key) => key !== 'focusTaskId');
      if (unknown.length) {
        throw new HttpError(400, 'INVALID_DASHBOARD_AUTHORIZATION', 'Dashboard authorization accepts only focusTaskId');
      }
      const approval = await createDashboardApproval(auth, body.focusTaskId ?? null);
      sendJson(response, 201, approval, cors);
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
      const issued = await dashboardSessions.create({ focusTaskId: approval.focusTaskId });
      sendJson(response, 201, {
        ok: true,
        session: issued.session,
        expiresInMs: DASHBOARD_SESSION_TTL_MS
      }, { ...cors, 'set-cookie': ownerCookie(issued.token) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/dashboard/logout') {
      const auth = await authenticate(request);
      requireRole(auth, 'dashboard');
      requireDashboardMutationOrigin(request, auth);
      const cookie = parseCookie(request, DASHBOARD_COOKIE);
      if (cookie) await dashboardSessions.revoke(cookie);
      sendJson(response, 200, { ok: true }, { ...cors, 'set-cookie': ownerCookie('', { clear: true }) });
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

    if (request.method === 'GET' && url.pathname === '/v1/dashboard/summary') {
      const auth = await authenticate(request);
      requireRole(auth, 'dashboard');
      const counts = typeof taskService.schedulerStatus === 'function'
        ? await taskService.schedulerStatus()
        : {};
      sendJson(response, 200, {
        ok: true,
        version: VERSION,
        state: stopping ? 'stopping' : 'ready',
        startedAt,
        counts,
        focusTaskId: auth.focusTaskId ?? null
      }, cors);
      return;
    }

    const profileMatch = /^\/v1\/profiles\/([^/]+)$/.exec(url.pathname);
    const profileActionMatch = /^\/v1\/profiles\/([^/]+)\/(open|close)$/.exec(url.pathname);
    const agentActionMatch = /^\/v1\/agents\/([^/]+)\/actions$/.exec(url.pathname);
    const taskTypeMatch = /^\/v1\/task-types\/([^/]+)$/.exec(url.pathname);
    const taskTypeActionMatch = /^\/v1\/task-types\/([^/]+)\/actions$/.exec(url.pathname);
    const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
    const taskActionMatch = /^\/v1\/tasks\/([^/]+)\/(cancel|resume|continue)$/.exec(url.pathname);
    const taskWorkbenchActionMatch = /^\/v1\/tasks\/([^/]+)\/actions$/.exec(url.pathname);
    const taskCommandsMatch = /^\/v1\/tasks\/([^/]+)\/commands$/.exec(url.pathname);
    const taskCommandMatch = /^\/v1\/tasks\/([^/]+)\/commands\/([^/]+)$/.exec(url.pathname);
    const taskTimelineMatch = /^\/v1\/tasks\/([^/]+)\/timeline$/.exec(url.pathname);
    const taskRevisionMatch = /^\/v1\/tasks\/([^/]+)\/revision$/.exec(url.pathname);
    const taskReportMatch = /^\/v1\/tasks\/([^/]+)\/report$/.exec(url.pathname);
    const taskArtifactsMatch = /^\/v1\/tasks\/([^/]+)\/artifacts$/.exec(url.pathname);
    const taskArtifactMatch = /^\/v1\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);

    if (request.method === 'GET' && url.pathname === '/v1/agents') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'dashboard');
      const agents = await agentRegistry.list({ activityByClientId: await currentAgentActivity() });
      sendJson(response, 200, { agents }, cors);
      return;
    }
    if (agentActionMatch && request.method === 'POST') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'dashboard');
      const agentId = decodeURIComponent(agentActionMatch[1]);
      const body = await readJson(request, { maxBytes: 4 * 1024 });
      if (body.action === 'revoke') {
        const agent = await agentRegistry.revoke(agentId, { reason: body.reason });
        agentTouchAt.delete(agentId);
        sendJson(response, 200, { agent }, cors);
        return;
      }
      if (body.action === 'restore') {
        const agent = await agentRegistry.restore(agentId);
        sendJson(response, 200, { agent }, cors);
        return;
      }
      throw new HttpError(400, 'INVALID_AGENT_ACTION', 'Agent action must be revoke or restore');
    }

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
      void access; // Accepted only as a no-op for cached 2.0 clients.
      const profile = await profileStore.create(profileInput);
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
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const profileId = decodeURIComponent(profileMatch[1]);
      requireProfileAccess(await profileStore.get(profileId), auth, { manage: true });
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
    if (taskTypeActionMatch && request.method === 'POST') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'dashboard');
      const name = decodeURIComponent(taskTypeActionMatch[1]);
      const body = await readJson(request, { maxBytes: 4 * 1024 });
      let taskType;
      if (body.action === 'deprecate') {
        taskType = await requireTaskMethod(taskService, 'deprecateTaskType')(
          name,
          body.replacedBy === undefined ? {} : { replacedBy: body.replacedBy },
          serviceCaller(auth)
        );
      } else if (body.action === 'restore') {
        if (Object.keys(body).some((key) => key !== 'action')) {
          throw new HttpError(400, 'INVALID_TASK_TYPE_LIFECYCLE', 'Restore accepts only action');
        }
        taskType = await requireTaskMethod(taskService, 'restoreTaskType')(name, serviceCaller(auth));
      } else {
        throw new HttpError(400, 'INVALID_TASK_TYPE_ACTION', 'Task type action must be deprecate or restore');
      }
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
      const task = await requireTaskMethod(taskService, 'create')(
        validateTaskCreate(await readJson(request)),
        auth
      );
      const safeTask = publicTask(task);
      const { dashboardUrl } = await createDashboardApproval(auth, safeTask.id);
      sendJson(response, 202, { taskId: safeTask.id, dashboardUrl, task: safeTask }, cors);
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
    if (taskMatch && request.method === 'DELETE') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'dashboard');
      const deleted = await requireTaskMethod(taskService, 'deleteTask')(
        decodeURIComponent(taskMatch[1]),
        await readJson(request, { maxBytes: 4 * 1024 }),
        serviceCaller(auth)
      );
      sendJson(response, 200, { deleted }, cors);
      return;
    }
    if (taskTimelineMatch && request.method === 'GET') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const timeline = await requireTaskMethod(taskService, 'getTaskTimeline')(
        decodeURIComponent(taskTimelineMatch[1]),
        {
          afterSequence: Number(url.searchParams.get('afterSequence') ?? 0),
          limit: Number(url.searchParams.get('limit') ?? 100)
        },
        serviceCaller(auth)
      );
      sendJson(response, 200, timeline, cors);
      return;
    }
    if (taskWorkbenchActionMatch && request.method === 'POST') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'dashboard');
      const taskId = decodeURIComponent(taskWorkbenchActionMatch[1]);
      const body = await readJson(request, { maxBytes: 16 * 1024 });
      const { action, ...command } = body;
      let task;
      if (action === 'pause' || action === 'hold') {
        task = await requireTaskMethod(taskService, 'pauseTask')(taskId, command, serviceCaller(auth));
      } else if (action === 'resume') {
        task = await requireTaskMethod(taskService, 'resumePausedTask')(taskId, command, serviceCaller(auth));
      } else if (action === 'cancel' || action === 'terminate') {
        task = await requireTaskMethod(taskService, 'terminateTask')(taskId, command, serviceCaller(auth));
      } else {
        throw new HttpError(400, 'INVALID_TASK_ACTION', 'Task action must be pause, resume, or terminate');
      }
      sendJson(response, 202, { task: publicTask(task) }, cors);
      return;
    }
    if (taskCommandsMatch && request.method === 'POST') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'dashboard');
      const body = await readJson(request, { maxBytes: 16 * 1024 });
      const { text, ...commandBody } = body;
      const task = await requireTaskMethod(taskService, 'submitTaskCommand')(
        decodeURIComponent(taskCommandsMatch[1]),
        {
          ...commandBody,
          kind: body.kind === 'message' ? 'ask' : body.kind,
          message: body.message ?? text
        },
        serviceCaller(auth)
      );
      sendJson(response, 202, { task: publicTask(task) }, cors);
      return;
    }
    if (taskCommandMatch && request.method === 'POST') {
      const auth = await authenticate(request);
      requireRole(auth, 'agent');
      const result = await requireTaskMethod(taskService, 'respondTaskCommand')(
        decodeURIComponent(taskCommandMatch[1]),
        decodeURIComponent(taskCommandMatch[2]),
        await readJson(request, { maxBytes: 16 * 1024 }),
        auth
      );
      sendJson(response, 200, { ...result, task: publicTask(result.task) }, cors);
      return;
    }
    if (taskRevisionMatch && request.method === 'POST') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'dashboard');
      const task = await requireTaskMethod(taskService, 'reviseQueuedTask')(
        decodeURIComponent(taskRevisionMatch[1]),
        await readJson(request, { maxBytes: 128 * 1024 }),
        serviceCaller(auth)
      );
      sendJson(response, 200, { task: publicTask(task) }, cors);
      return;
    }
    if (taskReportMatch && request.method === 'POST') {
      const auth = await authenticate(request);
      requireRole(auth, 'agent');
      const task = await requireTaskMethod(taskService, 'publishTaskReport')(
        decodeURIComponent(taskReportMatch[1]),
        await readJson(request, { maxBytes: 128 * 1024 }),
        auth
      );
      sendJson(response, 201, { task: publicTask(task) }, cors);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/agent/inbox/claim') {
      const auth = await authenticate(request);
      requireRole(auth, 'agent');
      const body = await readJson(request, { maxBytes: 4 * 1024 });
      const inbox = await requireTaskMethod(taskService, 'claimAgentInbox')(
        { limit: body.limit ?? 100 },
        auth
      );
      sendJson(response, 200, inbox, cors);
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
