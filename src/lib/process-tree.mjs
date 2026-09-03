import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_PROCESS_LIST_BYTES = 4 * 1024 * 1024;

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill?.('SIGKILL');
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}

function normalizedProfilePath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function commandLineProfileArguments(commandLine) {
  const values = [];
  const patterns = [
    /"--user-data-dir=([^"]+)"/gu,
    /--user-data-dir="([^"]+)"/gu,
    /--user-data-dir='([^']+)'/gu,
    /(?:^|\s)--user-data-dir=([^\s"]+)/gu,
    /(?:^|\s)--user-data-dir\s+"([^"]+)"/gu,
    /(?:^|\s)--user-data-dir\s+'([^']+)'/gu,
    /(?:^|\s)--user-data-dir\s+([^\s"]+)/gu
  ];
  for (const pattern of patterns) {
    for (const match of commandLine.matchAll(pattern)) values.push(match[1]);
  }
  return values;
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function commandLineUsesProfile(commandLine, userDataDir, {
  caseInsensitive = process.platform === 'win32'
} = {}) {
  if (typeof commandLine !== 'string' || typeof userDataDir !== 'string' || !userDataDir) return false;
  // macOS `ps ... command=` joins argv with spaces and does not restore the
  // original quoting. Match the already-known exact Profile path rather than
  // attempting to split that lossy representation back into argv. A following
  // Chrome switch/URL (or end/quote) is the only accepted argument boundary,
  // which prevents `Profile` from matching `Profile Copy` or `Profile-2`.
  const escapedExpected = escapeRegularExpression(userDataDir);
  const prefixes = [
    `--user-data-dir=${escapedExpected}`,
    `--user-data-dir="${escapedExpected}"`,
    `--user-data-dir='${escapedExpected}'`,
    `--user-data-dir\\s+${escapedExpected}`,
    `--user-data-dir\\s+"${escapedExpected}"`,
    `--user-data-dir\\s+'${escapedExpected}'`
  ];
  const boundary = String.raw`(?=$|["']|\s+(?:--|about:|chrome:|https?:\/\/|file:))`;
  const flags = caseInsensitive ? 'iu' : 'u';
  if (prefixes.some((prefix) => new RegExp(`(?:^|[\\s"'])${prefix}${boundary}`, flags).test(commandLine))) {
    return true;
  }

  const normalizedExpected = normalizedProfilePath(userDataDir);
  return commandLineProfileArguments(commandLine).some((value) => {
    try {
      return normalizedProfilePath(value) === normalizedExpected;
    } catch {
      return false;
    }
  });
}

function capture(command, args, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill?.('SIGKILL');
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_PROCESS_LIST_BYTES) {
        child.kill?.('SIGKILL');
        finish(null);
      }
    });
    child.once('error', () => finish(null));
    child.once('exit', (code) => finish(code === 0 ? stdout : null));
  });
}

async function probeLinuxProfile(userDataDir) {
  let entries;
  try {
    entries = await readdir('/proc', { withFileTypes: true });
  } catch {
    return 'unknown';
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    let executable;
    try {
      executable = (await readFile(`/proc/${entry.name}/comm`, 'utf8')).trim().toLowerCase();
    } catch {
      continue;
    }
    if (!/(?:^|-)chrome$|chromium(?:-browser)?$/u.test(executable)) continue;
    let source;
    try {
      source = await readFile(`/proc/${entry.name}/cmdline`);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') continue;
      return 'unknown';
    }
    const args = source.toString('utf8').split('\0').filter(Boolean);
    const commandLine = args.map((arg) => arg.includes(' ') ? `"${arg}"` : arg).join(' ');
    if (commandLineUsesProfile(commandLine, userDataDir)) return 'active';
  }
  return 'inactive';
}

/**
 * Returns active, inactive, or unknown without logging any process command line.
 * Only an explicit --user-data-dir argument equal to the resolved Profile path
 * counts as active; ambiguous enumeration failures remain fenced as unknown.
 */
export async function probeChromeProfileUsage(userDataDir) {
  if (typeof userDataDir !== 'string' || !userDataDir) return 'unknown';
  if (process.platform === 'linux') return probeLinuxProfile(userDataDir);

  if (process.platform === 'win32') {
    const source = await capture('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | ForEach-Object { if ($null -ne $_.CommandLine) { $_.CommandLine } }"
    ]);
    if (source === null) return 'unknown';
    return source.split(/\r?\n/u).some((line) => commandLineUsesProfile(line, userDataDir))
      ? 'active'
      : 'inactive';
  }

  if (process.platform === 'darwin') {
    const source = await capture('ps', ['-Aww', '-o', 'comm=', '-o', 'command=']);
    if (source === null) return 'unknown';
    return source.split(/\r?\n/u).some((line) => (
      /(?:Google Chrome|Chromium)/u.test(line) && commandLineUsesProfile(line, userDataDir)
    )) ? 'active' : 'inactive';
  }
  return 'unknown';
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function terminateProcessTree(pid, { graceMs = 5_000 } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (process.platform === 'win32') {
    const terminated = await run(
      'taskkill.exe',
      ['/PID', String(pid), '/T', '/F'],
      Math.max(1_000, graceMs)
    );
    // taskkill /T is the operating-system primitive that owns the descendant
    // walk. A missing/failed taskkill is not cleanup proof, even if the root
    // PID disappeared while the command was running.
    return terminated && !isProcessAlive(pid);
  }

  signalProcessGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isProcessGroupAlive(pid)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (isProcessGroupAlive(pid)) {
    signalProcessGroup(pid, 'SIGKILL');
    const killDeadline = Date.now() + Math.max(1_000, Math.min(3_000, graceMs));
    while (Date.now() < killDeadline && isProcessGroupAlive(pid)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  return !isProcessGroupAlive(pid);
}
