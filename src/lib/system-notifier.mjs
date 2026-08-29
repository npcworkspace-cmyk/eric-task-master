import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 5_000;
const WINDOWS_APP_ID = 'NPC.EricTaskMaster';
const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:19946/dashboard';
const WINDOWS_HELPER = fileURLToPath(new URL('./windows-notification.ps1', import.meta.url));
const STATES = new Set(['ready', 'needs_setup', 'permission_blocked', 'unavailable', 'test_failed']);

function boundedText(value, maximum) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maximum);
}

function boundedHttpUrl(value, fallback = DEFAULT_DASHBOARD_URL) {
  try {
    const url = new URL(String(value || fallback));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fallback;
    return url.href.slice(0, 2_048);
  } catch {
    return fallback;
  }
}

function base64(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

function windowsExecutable(environment) {
  return environment.SystemRoot
    ? `${environment.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe';
}

function windowsCommand(mode, { title = '', message = '', targetUrl = '', dashboardUrl = DEFAULT_DASHBOARD_URL } = {}, environment) {
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_HELPER,
    '-Mode', mode,
    '-AppId', WINDOWS_APP_ID,
    '-DashboardUrlB64', base64(boundedHttpUrl(dashboardUrl))
  ];
  if (mode === 'show') {
    args.push(
      '-TitleB64', base64(boundedText(title || 'Eric Task Master', 120)),
      '-MessageB64', base64(boundedText(message || 'A browser task needs attention.', 300)),
      '-TargetUrlB64', base64(boundedHttpUrl(targetUrl || dashboardUrl))
    );
  }
  return { executable: windowsExecutable(environment), args };
}

function commandFor(platform, operation, payload, environment) {
  if (platform === 'win32') return windowsCommand(operation, payload, environment);
  if (operation === 'open-settings' && platform === 'darwin') {
    return { executable: 'open', args: ['x-apple.systempreferences:com.apple.Notifications-Settings.extension'] };
  }
  if (operation !== 'show') return null;
  const title = boundedText(payload.title || 'Eric Task Master', 120);
  const message = boundedText(payload.message || 'A browser task needs attention.', 300);
  if (platform === 'darwin') {
    return {
      executable: 'osascript',
      args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message]
    };
  }
  if (platform === 'linux') {
    return { executable: 'notify-send', args: ['--app-name=Eric Task Master', title, message] };
  }
  return null;
}

function executableExists(executable, environment, platform) {
  if (executable.includes('/') || executable.includes('\\')) return existsSync(executable);
  return String(environment.PATH || environment.Path || '')
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => existsSync(join(directory, executable)) || (
      platform === 'win32' && existsSync(join(directory, `${executable}.exe`))
    ));
}

function defaultPrerequisite(platform, environment) {
  if (platform === 'win32') return existsSync(WINDOWS_HELPER) && executableExists(windowsExecutable(environment), environment, platform);
  if (platform === 'darwin') return executableExists('/usr/bin/osascript', environment, platform);
  if (platform === 'linux') {
    const graphicalSession = Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
    return graphicalSession && executableExists('notify-send', environment, platform);
  }
  return false;
}

function commandError(exitCode) {
  const error = new Error('System notification command failed');
  if (exitCode === 20) error.code = 'SYSTEM_NOTIFICATION_NEEDS_SETUP';
  else if (exitCode === 21) error.code = 'SYSTEM_NOTIFICATION_PERMISSION_BLOCKED';
  else error.code = 'SYSTEM_NOTIFICATION_FAILED';
  error.exitCode = exitCode;
  return error;
}

function run(command, { spawnImpl, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      child?.kill?.();
      const error = new Error('System notification was aborted');
      error.code = 'SYSTEM_NOTIFICATION_ABORTED';
      finish(error);
    };
    const timer = setTimeout(() => {
      child?.kill?.();
      const error = new Error('System notification timed out');
      error.code = 'SYSTEM_NOTIFICATION_TIMEOUT';
      finish(error);
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      child = spawnImpl(command.executable, command.args, {
        stdio: 'ignore',
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      finish(error);
      return;
    }
    child.once('error', finish);
    child.once('exit', (code) => code === 0 ? finish() : finish(commandError(code)));
  });
}

function stateFromError(error, { setup = false } = {}) {
  if (error?.code === 'SYSTEM_NOTIFICATION_PERMISSION_BLOCKED') return 'permission_blocked';
  if (error?.code === 'SYSTEM_NOTIFICATION_NEEDS_SETUP') return 'needs_setup';
  if (error?.code === 'SYSTEM_NOTIFICATION_NOT_CONFIGURED' || error?.code === 'SYSTEM_NOTIFICATION_UNSUPPORTED') return 'unavailable';
  return setup ? 'needs_setup' : 'test_failed';
}

export function createSystemNotifier({
  platform = process.platform,
  environment = process.env,
  spawnImpl = spawn,
  probe,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  dashboardUrl = DEFAULT_DASHBOARD_URL
} = {}) {
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
  if (probe !== undefined && typeof probe !== 'function') throw new TypeError('probe must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new TypeError('timeoutMs must be between 100 and 30000');
  }
  if (typeof dashboardUrl !== 'string' && typeof dashboardUrl !== 'function') {
    throw new TypeError('dashboardUrl must be a string or function');
  }
  const currentDashboardUrl = () => {
    try {
      return boundedHttpUrl(typeof dashboardUrl === 'function' ? dashboardUrl() : dashboardUrl);
    } catch {
      return DEFAULT_DASHBOARD_URL;
    }
  };
  const supported = ['win32', 'darwin', 'linux'].includes(platform);
  const prerequisite = supported && (probe ? probe({ platform, environment }) === true : defaultPrerequisite(platform, environment));
  let state = !supported || !prerequisite
    ? 'unavailable'
    : platform === 'win32'
      ? 'needs_setup'
      : 'ready';
  let initialized = platform !== 'win32' || !prerequisite;
  let lastErrorCode = null;

  const status = () => Object.freeze({
    state: STATES.has(state) ? state : 'unavailable',
    supported,
    configured: ['ready', 'permission_blocked', 'test_failed'].includes(state),
    canOpenSettings: platform === 'win32' || platform === 'darwin',
    ...(lastErrorCode ? { code: lastErrorCode } : {})
  });

  const initialize = async ({ force = false } = {}) => {
    if (!supported || !prerequisite) return status();
    if (initialized && !force) return status();
    if (platform !== 'win32') {
      initialized = true;
      state = 'ready';
      lastErrorCode = null;
      return status();
    }
    try {
      await run(commandFor(platform, 'setup', { dashboardUrl: currentDashboardUrl() }, environment), { spawnImpl, timeoutMs });
      state = 'ready';
      lastErrorCode = null;
    } catch (error) {
      state = stateFromError(error, { setup: true });
      lastErrorCode = boundedText(error?.code, 64) || 'SYSTEM_NOTIFICATION_FAILED';
    }
    initialized = true;
    return status();
  };

  const notify = async ({ title, message, targetUrl, signal } = {}) => {
    if (!supported) {
      const error = new Error('System notifications are unsupported on this platform');
      error.code = 'SYSTEM_NOTIFICATION_UNSUPPORTED';
      throw error;
    }
    if (!prerequisite) {
      const error = new Error('System notification command or graphical session is unavailable');
      error.code = 'SYSTEM_NOTIFICATION_NOT_CONFIGURED';
      throw error;
    }
    await initialize({ force: state === 'permission_blocked' });
    if (!['ready', 'test_failed'].includes(state)) {
      const error = new Error('System notifications are not ready');
      error.code = lastErrorCode || (state === 'permission_blocked'
        ? 'SYSTEM_NOTIFICATION_PERMISSION_BLOCKED'
        : 'SYSTEM_NOTIFICATION_NEEDS_SETUP');
      throw error;
    }
    const command = commandFor(platform, 'show', {
      title,
      message,
      targetUrl,
      dashboardUrl: currentDashboardUrl()
    }, environment);
    try {
      await run(command, { spawnImpl, timeoutMs, signal });
      state = 'ready';
      lastErrorCode = null;
      return status();
    } catch (error) {
      state = stateFromError(error);
      lastErrorCode = boundedText(error?.code, 64) || 'SYSTEM_NOTIFICATION_FAILED';
      throw error;
    }
  };

  const openSettings = async () => {
    const command = commandFor(platform, 'open-settings', { dashboardUrl: currentDashboardUrl() }, environment);
    if (!command) {
      const error = new Error('System notification settings cannot be opened on this platform');
      error.code = 'SYSTEM_NOTIFICATION_SETTINGS_UNAVAILABLE';
      throw error;
    }
    await run(command, { spawnImpl, timeoutMs });
    return status();
  };

  Object.defineProperties(notify, {
    supported: { get: () => supported, enumerable: true },
    configured: { get: () => status().configured, enumerable: true },
    status: { value: status, enumerable: true },
    initialize: { value: initialize, enumerable: true },
    openSettings: { value: openSettings, enumerable: true }
  });
  return notify;
}

export const SYSTEM_NOTIFICATION_DEFAULTS = Object.freeze({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  appId: WINDOWS_APP_ID,
  dashboardUrl: DEFAULT_DASHBOARD_URL
});
