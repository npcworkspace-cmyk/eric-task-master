import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION, DEFAULT_HOST, DEFAULT_PORT, VERSION } from './contracts.mjs';
import { HttpError, readJson, sendJson, serveStatic } from './lib/http-utils.mjs';
import { JsonStore } from './lib/json-store.mjs';
import { ManagerLock } from './lib/manager-lock.mjs';
import { OperationalJournal } from './lib/operational-journal.mjs';
import { ProfileStore, ProfileStoreError } from './lib/profile-store.mjs';
import { redactSensitiveText, redactSensitiveValue } from './lib/redaction.mjs';
import { createTaskService, TaskServiceError } from './runtime/task-service.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function defaultDataDirectory() {
  if (process.env.ERIC_TASK_MASTER_HOME) return path.resolve(process.env.ERIC_TASK_MASTER_HOME);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'eric-task-master');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'eric-task-master');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'eric-task-master');
}

function secureEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseBearer(request) {
  const value = request.headers.authorization;
  if (typeof value !== 'string') return null;
  return /^Bearer\s+([^\s]+)$/iu.exec(value)?.[1] ?? null;
}

function requestHostIsLoopback(request) {
  try {
    const hostname = new URL(`http://${request.headers.host}`).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

function dashboardSameOrigin(request, origin) {
  const requestOrigin = request.headers.origin;
  if (typeof requestOrigin === 'string') return requestOrigin === origin;
  const referer = request.headers.referer;
  if (typeof referer === 'string') {
    try {
      return new URL(referer).origin === origin;
    } catch {
      return false;
    }
  }
  return request.method === 'GET' && request.headers['sec-fetch-site'] === 'same-origin';
}

function errorPayload(error, requestId) {
  const known = error instanceof HttpError || error instanceof TaskServiceError || error instanceof ProfileStoreError;
  const statusCode = known ? error.statusCode ?? 400 : 500;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const message = known ? error.message : 'Internal Manager error';
  return {
    statusCode,
    body: {
      ok: false,
      requestId,
      error: {
        code: redactSensitiveText(String(code)).slice(0, 100),
        message: redactSensitiveText(String(message)).slice(0, 4_000),
        ...(error?.details === undefined ? {} : { details: redactSensitiveValue(error.details) })
      },
      ...(error?.nextAction
        ? { nextAction: redactSensitiveText(String(error.nextAction)).slice(0, 2_000) }
        : {})
    }
  };
}

function integerParam(value, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, 'INVALID_PARAMETER', 'Numeric query parameter is invalid');
  }
  return parsed;
}

export async function createManager({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  dataDir = defaultDataDirectory(),
  dashboardDir = path.resolve(MODULE_DIR, '..', 'dashboard'),
  taskServiceFactory = createTaskService,
  profileProcessAlive,
  taskServiceOptions = {}
} = {}) {
  if (host !== DEFAULT_HOST) throw new TypeError(`Manager must bind to ${DEFAULT_HOST}`);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError('port is invalid');
  const resolvedDataDir = path.resolve(dataDir);
  await mkdir(resolvedDataDir, { recursive: true, mode: 0o700 });
  const managerLock = new ManagerLock(path.join(resolvedDataDir, '.manager.lock'));
  await managerLock.acquire();

  let server;
  let taskService;
  let stopped = false;
  let stopping = false;
  let stopPromise;
  let address;
  const journal = new OperationalJournal({ stateDir: resolvedDataDir });
  try {
    const configStore = new JsonStore(path.join(resolvedDataDir, 'config.json'), () => ({
      version: 3,
      managerToken: randomBytes(32).toString('base64url'),
      createdAt: new Date().toISOString()
    }));
    await configStore.init();
    let config = await configStore.read();
    if (typeof config.managerToken !== 'string' || config.managerToken.length < 32) {
      config = await configStore.update((draft) => {
        draft.version = 3;
        draft.managerToken = randomBytes(32).toString('base64url');
      });
    }
    const token = config.managerToken;

    const profileStore = new ProfileStore({
      filePath: path.join(resolvedDataDir, 'profiles.json'),
      profilesRoot: path.join(resolvedDataDir, 'profiles'),
      ...(profileProcessAlive ? { processAlive: profileProcessAlive } : {})
    });
    await profileStore.init();
    taskService = await taskServiceFactory({
      stateDir: path.join(resolvedDataDir, 'tasks'),
      profileStore,
      ...taskServiceOptions
    });

    const handle = async (request, response) => {
      const started = Date.now();
      const requestId = `req_${randomBytes(12).toString('hex')}`;
      let pathname = '/';
      try {
        if (!requestHostIsLoopback(request)) throw new HttpError(403, 'LOOPBACK_REQUIRED', 'Loopback Host is required');
        const base = address ? `http://${host}:${address.port}` : `http://${host}:${port}`;
        const url = new URL(request.url || '/', base);
        pathname = url.pathname;

        if (request.method === 'GET' && pathname === '/v1/health') {
          sendJson(response, 200, {
            ok: true,
            service: 'eric-task-master',
            version: VERSION,
            apiVersion: API_VERSION,
            state: stopping ? 'stopping' : 'ready',
            pid: process.pid
          });
          return;
        }
        if (request.method === 'GET' && (pathname === '/dashboard' || pathname === '/dashboard/')) {
          await serveStatic(response, dashboardDir, 'index.html');
          return;
        }
        if (request.method === 'GET' && pathname.startsWith('/dashboard/')) {
          await serveStatic(response, dashboardDir, pathname.slice('/dashboard/'.length));
          return;
        }

        const authenticated = secureEqual(parseBearer(request), token) || dashboardSameOrigin(request, base);
        if (!authenticated) throw new HttpError(401, 'AUTH_REQUIRED', 'Local Manager authorization is required');
        const managerStopRequest = request.method === 'POST' && pathname === '/v1/manager/stop';
        if (
          stopping && !(request.method === 'GET' && pathname.startsWith('/v1/')) &&
          !managerStopRequest
        ) {
          throw new HttpError(503, 'MANAGER_STOPPING', 'Manager is stopping');
        }

        if (request.method === 'GET' && pathname === '/v1/status') {
          sendJson(response, 200, { ok: true, ...(await taskService.status()) });
          return;
        }
        if (request.method === 'GET' && pathname === '/v1/tasks') {
          sendJson(response, 200, { ok: true, tasks: await taskService.list() });
          return;
        }
        if (request.method === 'POST' && pathname === '/v1/tasks') {
          sendJson(response, 201, { ok: true, task: await taskService.create(await readJson(request, { maxBytes: 8 * 1024 * 1024 })) });
          return;
        }
        if (request.method === 'GET' && pathname === '/v1/profiles') {
          sendJson(response, 200, { ok: true, profiles: await taskService.listProfiles() });
          return;
        }
        if (request.method === 'POST' && pathname === '/v1/profiles') {
          sendJson(response, 201, { ok: true, profile: await taskService.createProfile(await readJson(request)) });
          return;
        }
        if (request.method === 'POST' && pathname === '/v1/manager/stop') {
          sendJson(response, 202, { ok: true, state: 'stopping' });
          setImmediate(() => {
            void stop().catch((error) => journal.append({
              level: 'error',
              event: 'manager.stop_failed',
              code: error?.code || 'MANAGER_CLEANUP_FAILED',
              message: redactSensitiveText(error?.message || 'Manager cleanup failed'),
              state: 'stopping'
            }).catch(() => {}));
          });
          return;
        }

        const taskMatch = /^\/v1\/tasks\/([^/]+)$/u.exec(pathname);
        const taskActions = /^\/v1\/tasks\/([^/]+)\/actions$/u.exec(pathname);
        const taskEvents = /^\/v1\/tasks\/([^/]+)\/events$/u.exec(pathname);
        const taskArtifacts = /^\/v1\/tasks\/([^/]+)\/artifacts$/u.exec(pathname);
        const profileMatch = /^\/v1\/profiles\/([^/]+)$/u.exec(pathname);
        const profileActions = /^\/v1\/profiles\/([^/]+)\/actions$/u.exec(pathname);

        if (taskMatch && request.method === 'GET') {
          sendJson(response, 200, { ok: true, task: await taskService.get(decodeURIComponent(taskMatch[1])) });
          return;
        }
        if (taskMatch && request.method === 'DELETE') {
          sendJson(response, 200, { ok: true, ...(await taskService.deleteTask(decodeURIComponent(taskMatch[1]))) });
          return;
        }
        if (taskActions && request.method === 'POST') {
          const taskId = decodeURIComponent(taskActions[1]);
          const body = await readJson(request);
          if (body.action === 'stop') {
            sendJson(response, 200, { ok: true, task: await taskService.stop(taskId) });
            return;
          }
          if (body.action === 'resume') {
            sendJson(response, 200, { ok: true, task: await taskService.resume(taskId, body.value ?? null) });
            return;
          }
          throw new HttpError(400, 'INVALID_TASK_ACTION', 'Task action must be stop or resume');
        }
        if (taskEvents && request.method === 'GET') {
          sendJson(response, 200, {
            ok: true,
            ...(await taskService.events(decodeURIComponent(taskEvents[1]), {
              after: integerParam(url.searchParams.get('after'), 0),
              limit: integerParam(url.searchParams.get('limit'), 200, { minimum: 1, maximum: 1_000 })
            }))
          });
          return;
        }
        if (taskArtifacts && request.method === 'GET') {
          const taskId = decodeURIComponent(taskArtifacts[1]);
          const requestedPath = url.searchParams.get('path');
          if (requestedPath) {
            sendJson(response, 200, {
              ok: true,
              artifact: await taskService.readArtifact(taskId, requestedPath, {
                offset: integerParam(url.searchParams.get('offset'), 0),
                maxBytes: integerParam(url.searchParams.get('maxBytes'), 256 * 1024, {
                  minimum: 1,
                  maximum: 4 * 1024 * 1024
                })
              })
            });
          } else {
            sendJson(response, 200, {
              ok: true,
              ...(await taskService.listArtifacts(taskId, {
                offset: integerParam(url.searchParams.get('offset'), 0),
                limit: integerParam(url.searchParams.get('limit'), 10_000, {
                  minimum: 1,
                  maximum: 10_000
                })
              }))
            });
          }
          return;
        }
        if (profileMatch && request.method === 'PATCH') {
          sendJson(response, 200, {
            ok: true,
            profile: await taskService.updateProfile(
              decodeURIComponent(profileMatch[1]),
              await readJson(request)
            )
          });
          return;
        }
        if (profileMatch && request.method === 'DELETE') {
          sendJson(response, 200, {
            ok: true,
            ...(await taskService.deleteProfile(decodeURIComponent(profileMatch[1])))
          });
          return;
        }
        if (profileActions && request.method === 'POST') {
          const identifier = decodeURIComponent(profileActions[1]);
          const body = await readJson(request);
          if (body.action === 'open') {
            sendJson(response, 200, { ok: true, ...(await taskService.openProfile(identifier)) });
            return;
          }
          if (body.action === 'close') {
            sendJson(response, 200, { ok: true, ...(await taskService.closeProfile(identifier)) });
            return;
          }
          throw new HttpError(400, 'INVALID_PROFILE_ACTION', 'Profile action must be open or close');
        }
        throw new HttpError(404, 'NOT_FOUND', 'Endpoint was not found');
      } catch (error) {
        const failure = errorPayload(error, requestId);
        sendJson(response, failure.statusCode, failure.body);
        await journal.append({
          level: failure.statusCode >= 500 ? 'error' : 'warn',
          event: 'request.failed',
          requestId,
          method: request.method,
          pathname,
          statusCode: failure.statusCode,
          code: failure.body.error.code,
          durationMs: Date.now() - started
        }).catch(() => {});
      }
    };

    server = http.createServer((request, response) => void handle(request, response));
    server.on('clientError', (_error, socket) => socket.destroy());

    async function start() {
      if (address) return address;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      address = server.address();
      await journal.append({
        level: 'info',
        event: 'manager.started',
        version: VERSION,
        pid: process.pid,
        port: address.port,
        state: 'ready'
      }).catch(() => {});
      return address;
    }

    async function stop() {
      if (stopPromise) return stopPromise;
      const attempt = (async () => {
        stopping = true;
        await taskService.close();
        if (address) {
          await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
        address = null;
        stopped = true;
        await managerLock.release();
      })();
      stopPromise = attempt;
      try {
        return await attempt;
      } catch (error) {
        if (stopPromise === attempt) stopPromise = null;
        throw error;
      }
    }

    return Object.freeze({
      start,
      stop,
      get baseUrl() { return address ? `http://${host}:${address.port}` : null; },
      get address() { return address; },
      get stopped() { return stopped; },
      taskService,
      profileStore
    });
  } catch (error) {
    await taskService?.close?.().catch(() => {});
    await managerLock.release().catch(() => {});
    throw error;
  }
}

export async function startManager(options = {}) {
  const manager = await createManager(options);
  await manager.start();
  return manager;
}
