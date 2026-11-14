import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.mjs';

const execFile = promisify(execFileCallback);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const CLI = path.join(ROOT, 'src/cli.mjs');
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isolatedHarnessEnvironment(stateDir, inherited = process.env) {
  const env = { ...inherited };
  for (const name of Object.keys(env)) {
    if (['ERIC_TASK_MASTER_PORT', 'ERIC_TASK_MASTER_HOME'].includes(name.toUpperCase())) delete env[name];
  }
  return { ...env, ERIC_TASK_MASTER_HOME: stateDir, NODE_OPTIONS: '' };
}

export async function createOperationsHarness({ outputDir, label = 'fast-acceptance', port, executeFile = execFile, startFixture = startFixtureServer } = {}) {
  const directory = path.resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const stateDir = path.join(directory, 'isolated-state');
  await mkdir(stateDir, { recursive: true });
  const fixture = await startFixture({ stateFile: path.join(directory, 'fixture-state.json'), port });
  const env = isolatedHarnessEnvironment(stateDir);
  const calls = [];
  const ids = [];
  let sequence = 0;
  const cli = async (args, { expectedFailure = false, timeout = 90000 } = {}) => {
    const started = performance.now();
    let result;
    try { result = await executeFile(process.execPath, [CLI, ...args, '--state-dir', stateDir, '--json'], { cwd: ROOT, env, windowsHide: true, timeout, maxBuffer: 12 * 1024 * 1024 }); }
    catch (error) { if (!expectedFailure) throw Object.assign(new Error(`${args.slice(0, 2).join(' ')}: ${error.stdout || error.message}`), { code: error.code }); result = error; }
    const rows = String(result.stdout || result.stderr || '').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    const value = rows.at(-1);
    calls.push({ command: args.slice(0, 2).join(' '), elapsedMs: performance.now() - started, ok: !value?.error, at: new Date().toISOString() });
    return value;
  };
  try {
  const managerStart = await cli(['manager', 'start']);
  const created = await cli(['profiles', 'create', label]);
  const profile = created.profile;
  if (!profile?.id) throw new Error('Isolated Profile creation did not return an id');
  const waitOperation = async (id, predicate, timeoutMs = 60000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const operation = await cli(['ops', 'get', id]);
      if (predicate(operation)) return operation;
      if (operation.task?.state === 'error') throw new Error(`Worker failed: ${JSON.stringify(operation.task.error)}`);
      await pause(100);
    }
    throw new Error(`Operation ${id} did not reach expected state`);
  };
  const start = async (kind, options = {}) => {
    const resourceId = kind === 'social' ? 'post-1' : kind === 'ads' ? 'campaign-1' : 'config-1';
    const allowedActions = ['navigate', 'fill', 'click', 'select', 'scroll', 'key', 'social.prepare', 'social.reply', 'ads.prepare', 'ads.adjust', 'site.prepare', 'site.configure'];
    const body = {
      goal: `Isolated ${kind} workflow`, businessKind: kind,
      mode: 'operations', browserSelection: { kind: 'profile', profileId: profile.id },
      authorization: { accountId: 'account-1', resourceIds: [resourceId], origins: [fixture.origin], allowedActions, expiresAt: new Date(Date.now() + 48 * 3600000).toISOString() },
      identity: { account: { selector: '[data-account-id]', attribute: 'data-account-id' }, resource: { selector: '[data-resource-id]', attribute: 'data-resource-id' } },
      ...options
    };
    const operation = await cli(['ops', 'start', '--input', JSON.stringify(body)]);
    if (!operation?.id || !operation.taskId) throw new Error(`Operation start failed: ${JSON.stringify(operation)}`);
    ids.push(operation.id);
    return waitOperation(operation.id, (value) => value.task?.state === 'waiting');
  };
  const command = async (id, kind, payload = {}, extra = {}) => {
    const commandId = extra.commandId || `${label}-${++sequence}`;
    const body = { commandId, kind, payload, ...extra };
    const receipt = await cli(['ops', 'command', id, '--input', JSON.stringify(body)]);
    if (receipt?.error) throw new Error(`Command reservation failed: ${JSON.stringify(receipt)}`);
    const operation = await waitOperation(id, (value) => value.commands.some((item) => item.commandId === commandId && item.reply));
    return operation.commands.find((item) => item.commandId === commandId).reply;
  };
  const observe = (id, payload = {}) => command(id, 'observe', payload);
  const navigate = async (id, url) => {
    const observation = await observe(id);
    return command(id, 'batch', { preconditions: [{ url: observation.url }], stopConditions: [], actions: [{ actionId: `${label}-nav-${++sequence}`, type: 'navigate', effect: false, value: url, expected: { url } }], verify: [{ url }] }, { pageId: observation.pageId, pageVersion: observation.pageVersion });
  };
  const decide = async (id, event, batch, observation, summary = 'Explicit isolated acceptance decision supplied by test driver; no real platform action') => {
    await cli(['ops', 'ack', id, '--input', JSON.stringify({ eventId: event.id })]);
    const commandId = `${label}-decision-${++sequence}`;
    await cli(['ops', 'decide', id, '--input', JSON.stringify({ eventId: event.id, authorizationVersion: 1, summary, command: { commandId, kind: 'batch', pageId: observation.pageId, pageVersion: observation.pageVersion, payload: batch } })]);
    const operation = await waitOperation(id, (value) => value.commands.some((item) => item.commandId === commandId && item.reply));
    return operation.commands.find((item) => item.commandId === commandId).reply;
  };
  const stop = async (id) => {
    await cli(['ops', 'stop', id]);
    await waitOperation(id, (value) => ['stopped', 'finished', 'error'].includes(value.task?.state));
  };
  const finish = async () => {
    const errors = [];
    let managerBeforeStop;
    try { managerBeforeStop = (await cli(['manager', 'status'])).manager; } catch { /* the report below still checks that the isolated listener is closed */ }
    for (const id of ids) await stop(id).catch((error) => errors.push({ scope: id, message: error.message }));
    await cli(['manager', 'stop'], { timeout: 45000 }).catch((error) => errors.push({ scope: 'manager', message: error.message }));
    let managerPidEnded = null;
    if (managerBeforeStop?.pid) {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try { process.kill(managerBeforeStop.pid, 0); managerPidEnded = false; } catch (error) { managerPidEnded = error.code === 'ESRCH'; }
        if (managerPidEnded) break;
        await pause(100);
      }
      if (!managerPidEnded) errors.push({ scope: 'manager-process', message: 'Isolated Manager PID still alive or unobservable after stop' });
    }
    const stoppedStatus = await cli(['manager', 'status'], { expectedFailure: true, timeout: 10000 }).catch((error) => ({ error: { code: error.code, message: error.message } }));
    const listenerClosed = stoppedStatus?.error?.code === 'MANAGER_UNREACHABLE';
    if (!listenerClosed) errors.push({ scope: 'manager-listener', message: 'Isolated Manager did not report unreachable after stop', observed: stoppedStatus?.error?.code || 'reachable' });
    await fixture.close().catch((error) => errors.push({ scope: 'fixture', message: error.message }));
    await writeFile(path.join(directory, 'cli-timings.json'), JSON.stringify(calls, null, 2));
    const result = { ok: errors.length === 0, errors, statePreserved: true, managerPidEnded, listenerClosed };
    await writeFile(path.join(directory, 'cleanup-report.json'), JSON.stringify(result, null, 2));
    return result;
  };
  return { outputDir: directory, stateDir, fixture, profile, cli, calls, start, command, observe, navigate, decide, waitOperation, stop, finish,
    async control(flags) { return fetch(`${fixture.origin}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(flags) }).then((response) => response.json()); },
    async state() { return fetch(`${fixture.origin}/state`).then((response) => response.json()); },
    manager: managerStart.manager,
    async managerMetadata() { return (await cli(['manager', 'status'])).manager; }
  };
  } catch (error) {
    const cleanup = { initializationFailed: true, managerStopRequested: false, fixtureClosed: false, errors: [] };
    try {
      // Startup may have launched the isolated Manager before its CLI receipt was
      // lost. Scope this best-effort stop to the same explicit state directory.
      await cli(['manager', 'stop'], { expectedFailure: true, timeout: 45000 });
      cleanup.managerStopRequested = true;
    } catch (cleanupError) { cleanup.errors.push({ scope: 'manager', message: cleanupError.message }); }
    finally {
      try { await fixture.close(); cleanup.fixtureClosed = true; }
      catch (cleanupError) { cleanup.errors.push({ scope: 'fixture', message: cleanupError.message }); }
    }
    await writeFile(path.join(directory, 'startup-cleanup-report.json'), JSON.stringify(cleanup, null, 2)).catch(() => {});
    error.startupCleanup = cleanup;
    throw error;
  }
}
