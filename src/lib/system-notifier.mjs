import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 5_000;

function boundedText(value, maximum) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maximum);
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function windowsCommand(title, message, environment) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(message)}</text></binding></visual></toast>`;
  const encodedXml = Buffer.from(xml, 'utf8').toString('base64');
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedXml}')))`,
    `$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Eric Task Master').Show($toast)`
  ].join('; ');
  const executable = environment.SystemRoot
    ? `${environment.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe';
  return {
    executable,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      script
    ]
  };
}

function commandFor(platform, title, message, environment) {
  if (platform === 'win32') return windowsCommand(title, message, environment);
  if (platform === 'darwin') {
    return {
      executable: 'osascript',
      args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message]
    };
  }
  if (platform === 'linux') {
    return {
      executable: 'notify-send',
      args: ['--app-name=Eric Task Master', title, message]
    };
  }
  return null;
}

function executableExists(executable, environment) {
  if (executable.includes('/') || executable.includes('\\')) return existsSync(executable);
  return String(environment.PATH || environment.Path || '')
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => existsSync(join(directory, executable)) || (
      process.platform === 'win32' && existsSync(join(directory, `${executable}.exe`))
    ));
}

function defaultConfigured(platform, environment) {
  if (platform === 'win32') {
    const executable = environment.SystemRoot
      ? `${environment.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      : 'powershell.exe';
    return executableExists(executable, environment);
  }
  if (platform === 'darwin') return executableExists('/usr/bin/osascript', environment);
  if (platform === 'linux') {
    const graphicalSession = Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
    return graphicalSession && executableExists('notify-send', environment);
  }
  return false;
}

function run(command, { spawnImpl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child?.kill?.();
      const error = new Error('System notification timed out');
      error.code = 'SYSTEM_NOTIFICATION_TIMEOUT';
      finish(error);
    }, timeoutMs);
    timer.unref?.();
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
    child.once('exit', (code) => {
      if (code === 0) finish();
      else {
        const error = new Error('System notification command failed');
        error.code = 'SYSTEM_NOTIFICATION_FAILED';
        finish(error);
      }
    });
  });
}

export function createSystemNotifier({
  platform = process.platform,
  environment = process.env,
  spawnImpl = spawn,
  probe,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
  if (probe !== undefined && typeof probe !== 'function') throw new TypeError('probe must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new TypeError('timeoutMs must be between 100 and 30000');
  }
  const supported = ['win32', 'darwin', 'linux'].includes(platform);
  const configured = supported && (probe ? probe({ platform, environment }) === true : defaultConfigured(platform, environment));
  const notify = async ({ title, message } = {}) => {
    if (!configured) {
      const error = new Error(supported
        ? 'System notification command or graphical session is unavailable'
        : 'System notifications are unsupported on this platform');
      error.code = supported ? 'SYSTEM_NOTIFICATION_NOT_CONFIGURED' : 'SYSTEM_NOTIFICATION_UNSUPPORTED';
      throw error;
    }
    const safeTitle = boundedText(title || 'Eric Task Master', 120);
    const safeMessage = boundedText(message || 'A browser task needs attention.', 300);
    const command = commandFor(platform, safeTitle, safeMessage, environment);
    if (!command) {
      const error = new Error('System notifications are unsupported on this platform');
      error.code = 'SYSTEM_NOTIFICATION_UNSUPPORTED';
      throw error;
    }
    await run(command, { spawnImpl, timeoutMs });
  };
  Object.defineProperties(notify, {
    supported: { value: supported, enumerable: true },
    configured: { value: configured, enumerable: true }
  });
  return notify;
}

export const SYSTEM_NOTIFICATION_DEFAULTS = Object.freeze({ timeoutMs: DEFAULT_TIMEOUT_MS });
