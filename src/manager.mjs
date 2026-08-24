import http from 'node:http';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { JsonStore } from './lib/json-store.mjs';
import { ManagerLock } from './lib/manager-lock.mjs';
import {
  createManagerIdentityProof,
  createPairingApprovalCode,
  createPairingCode,
  generateManagerIdentity,
  MANAGER_SERVICE,
  parsePairingCode,
  validateIdentityNonce,
  validateManagerIdentity
} from './lib/manager-identity.mjs';
import { ProfileStore, ProfileStoreError } from './lib/profile-store.mjs';
import { redactSensitiveText, redactSensitiveValue } from './lib/redaction.mjs';
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
const PAIRING_APPROVAL_TTL_MS = 2 * 60_000;
const DASHBOARD_APPROVAL_TTL_MS = 2 * 60_000;
const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60_000;
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

function validateProfilePatch(body) {
  const allowed = new Set(['name', 'defaultBehavior', 'headless', 'browserChannel']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new HttpError(400, 'INVALID_PROFILE_PATCH', `Unsupported fields: ${unknown.join(', ')}`);
  }
  return body;
}

function validateProfileCreate(body) {
  const allowed = new Set(['name', 'kind', 'defaultBehavior', 'headless', 'browserChannel']);
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
    extensions: [],
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
      draft.extensions = Array.isArray(draft.extensions) ? draft.extensions : [];
    });
  }
  if (!Array.isArray(config.extensions)) {
    config = await configStore.update((draft) => {
      draft.extensions = [];
    });
  }
  if (!Array.isArray(config.agents)) {
    config = await configStore.update((draft) => {
      draft.agents = [];
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
  const challenges = new Map();
  const pairingApprovals = new Map();
  const dashboardApprovals = new Map();
  const dashboardSessions = new Map();
  let server;
  let startedAt;
  let listeningAddress;
  let stopped = false;

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

  function extensionRequestOrigin(request) {
    const origin = requestOrigin(request);
    const claimedId = request.headers['x-taskmaster-extension-id'];
    const claimedOrigin = typeof claimedId === 'string' && /^[a-p]{32}$/.test(claimedId)
      ? `chrome-extension://${claimedId}`
      : null;
    if (origin) {
      if (!isChromeExtensionOrigin(origin)) return null;
      return claimedOrigin && claimedOrigin !== origin ? null : origin;
    }
    // Chrome's privileged extension fetch may omit Origin. The one-time pairing
    // approval authenticates first contact; subsequent calls also require the
    // private extension token bound to this claimed, strictly validated ID.
    return claimedOrigin;
  }

  async function authenticate(request) {
    const bearer = parseBearer(request);
    if (!bearer) throw new HttpError(401, 'AUTH_REQUIRED', 'Bearer token is required');
    const origin = requestOrigin(request);
    if (secureEqual(bearer, config.managerToken)) {
      return { role: 'manager-admin', clientId: 'manager-admin' };
    }
    const hashed = tokenHash(bearer);
    const agent = config.agents.find((item) => secureEqual(item.tokenHash, hashed));
    if (agent) {
      return { role: 'agent', clientId: agent.clientId, agent };
    }
    const dashboard = dashboardSessions.get(hashed);
    if (dashboard) {
      if (dashboard.expiresAt <= now()) {
        dashboardSessions.delete(hashed);
      } else {
        return { role: 'dashboard', clientId: dashboard.clientId };
      }
    }
    const extension = config.extensions.find((item) => secureEqual(item.tokenHash, hashed));
    if (!extension) throw new HttpError(401, 'INVALID_TOKEN', 'Bearer token is invalid');
    if (extensionRequestOrigin(request) !== extension.origin) {
      throw new HttpError(403, 'EXTENSION_ORIGIN_MISMATCH', 'Extension credential origin does not match');
    }
    return { role: 'extension', clientId: `extension:${extension.id}`, extension };
  }

  async function pairExtension(request, response, cors) {
    const origin = extensionRequestOrigin(request);
    if (!origin) {
      throw new HttpError(403, 'EXTENSION_ORIGIN_REQUIRED', 'Chrome extension origin is required');
    }
    const body = await readJson(request, { maxBytes: 16 * 1024 });
    const challengeValue = typeof body.challenge === 'string' ? body.challenge : '';
    const pairingCode = typeof body.pairingCode === 'string' ? body.pairingCode : '';
    let parsedPairing;
    try {
      parsedPairing = parsePairingCode(pairingCode, managerIdentity.fingerprint);
    } catch {
      throw new HttpError(401, 'INVALID_PAIRING_CODE', 'Pairing code is invalid or expired');
    }
    const pending = challenges.get(challengeValue);
    challenges.delete(challengeValue);
    const approval = pairingApprovals.get(pairingCode);
    pairingApprovals.delete(pairingCode);
    if (
      !pending ||
      pending.origin !== origin ||
      pending.expiresAt < now() ||
      !approval ||
      approval.expiresAt < now() ||
      !secureEqual(pending.approvalHash, tokenHash(pairingCode)) ||
      !secureEqual(parsedPairing.approvalCode, approval.approvalCode)
    ) {
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

    if (request.method === 'POST' && url.pathname === '/v1/agents/issue') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin');
      const body = await readJson(request, { maxBytes: 16 * 1024 });
      const clientId = validateClientId(body.clientId);
      const name = typeof body.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 80)
        : clientId;
      const agentToken = token();
      const agent = {
        credentialId: randomBytes(12).toString('hex'),
        clientId,
        name,
        tokenHash: tokenHash(agentToken),
        createdAt: new Date(now()).toISOString()
      };
      config = await configStore.update((draft) => {
        draft.agents = Array.isArray(draft.agents) ? draft.agents : [];
        draft.agents.push(agent);
        let remainingForClient = 8;
        draft.agents = draft.agents.reverse().filter((item) => (
          item.clientId !== clientId || remainingForClient-- > 0
        )).reverse();
      });
      sendJson(response, 201, { agentToken, agent: publicAgent(agent) }, cors);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/pair/authorize') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin');
      await readJson(request, { maxBytes: 4 * 1024 });
      for (const [code, approval] of pairingApprovals) {
        if (approval.expiresAt < now()) pairingApprovals.delete(code);
      }
      while (pairingApprovals.size >= 8) pairingApprovals.delete(pairingApprovals.keys().next().value);
      const approvalCode = createPairingApprovalCode();
      const pairingCode = createPairingCode(approvalCode, managerIdentity.fingerprint);
      pairingApprovals.set(pairingCode, {
        approvalCode,
        expiresAt: now() + PAIRING_APPROVAL_TTL_MS
      });
      sendJson(response, 201, {
        pairingCode,
        expiresInMs: PAIRING_APPROVAL_TTL_MS
      }, cors);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/dashboard/authorize') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'extension');
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

    if (request.method === 'GET' && url.pathname === '/v1/pair/challenge') {
      const origin = extensionRequestOrigin(request);
      if (!origin) {
        throw new HttpError(403, 'EXTENSION_ORIGIN_REQUIRED', 'Chrome extension origin is required');
      }
      for (const [value, pending] of challenges) {
        if (pending.expiresAt < now() || pending.origin === origin) challenges.delete(value);
      }
      const pairingCode = request.headers['x-taskmaster-pairing-code'];
      let parsedPairing;
      try {
        parsedPairing = parsePairingCode(pairingCode, managerIdentity.fingerprint);
      } catch {
        parsedPairing = null;
      }
      const approval = parsedPairing ? pairingApprovals.get(pairingCode) : null;
      if (!approval || approval.expiresAt < now()) {
        throw new HttpError(401, 'PAIRING_APPROVAL_REQUIRED', 'A valid one-time pairing approval is required');
      }
      const challenge = token();
      challenges.set(challenge, {
        origin,
        approvalHash: tokenHash(pairingCode),
        expiresAt: now() + PAIRING_CHALLENGE_TTL_MS
      });
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
    const taskTypeMatch = /^\/v1\/task-types\/([^/]+)$/.exec(url.pathname);
    const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
    const taskActionMatch = /^\/v1\/tasks\/([^/]+)\/(cancel|resume|continue)$/.exec(url.pathname);
    const taskArtifactsMatch = /^\/v1\/tasks\/([^/]+)\/artifacts$/.exec(url.pathname);
    const taskArtifactMatch = /^\/v1\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);

    if (request.method === 'GET' && url.pathname === '/v1/profiles') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'extension', 'dashboard');
      const profiles = (await profileStore.list()).map(publicProfile);
      sendJson(response, 200, { profiles }, cors);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/profiles') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'extension', 'dashboard');
      const profile = await profileStore.create(validateProfileCreate(await readJson(request)));
      sendJson(response, 201, { profile: publicProfile(profile) }, cors);
      return;
    }
    if (profileMatch && request.method === 'PATCH') {
      const auth = await authenticate(request);
      requireRole(auth, 'manager-admin', 'agent', 'extension', 'dashboard');
      const profileId = decodeURIComponent(profileMatch[1]);
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
      if (actionName === 'session') {
        requireRole(auth, 'extension');
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

      requireRole(auth, 'manager-admin', 'agent', 'extension', 'dashboard');

      if (actionName === 'open') {
        await profileStore.recoverExpiredLeases();
        await profileStore.get(profileId);
        const openProfile = requireTaskMethod(taskService, 'openProfile');
        await openProfile(profileId, serviceCaller(auth));
        sendJson(response, 200, { profile: publicProfile(await profileStore.get(profileId)) }, cors);
        return;
      }

      await profileStore.get(profileId);
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
    let serviceError;
    try {
      await taskService.close?.();
    } catch (error) {
      serviceError = error;
    } finally {
      if (server?.listening) {
        await new Promise((resolveStop, rejectStop) => {
          server.close((error) => error ? rejectStop(error) : resolveStop());
          server.closeAllConnections?.();
        });
      }
      listeningAddress = undefined;
      stopped = true;
      await managerLock.release().catch(() => {});
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
