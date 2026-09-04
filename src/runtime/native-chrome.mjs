import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { probeChromeProfileUsage } from '../lib/process-tree.mjs';

const execute = promisify(execFile);

function nativeError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

export function nativeChromeCandidates({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    return [...new Set([env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
      .filter(Boolean).map((root) => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')))];
  }
  if (platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.posix.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  ];
  if (platform === 'linux') return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
  return [];
}

export async function findNativeChrome({ candidates = nativeChromeCandidates(), checkAccess = access } = {}) {
  for (const candidate of candidates) {
    try { await checkAccess(candidate, constants.X_OK); return candidate; } catch { /* Try the next stable installation. */ }
  }
  throw nativeError('CHROME_UNAVAILABLE', 'Stable Google Chrome was not found on this computer');
}

async function requestNativeClose(child, platform) {
  // Only this live ChildProcess is eligible; never act on a PID recovered from disk.
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform !== 'win32') { child.kill('SIGTERM'); return; }
  await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $nativeChromePid=[int]$env:TASKMASTER_NATIVE_CHROME_PID; '
    + '$browser=Get-Process -Id $nativeChromePid -ErrorAction SilentlyContinue; '
    + 'if ($browser) { [void]$browser.CloseMainWindow() }'], {
    env: { ...process.env, TASKMASTER_NATIVE_CHROME_PID: String(child.pid) },
    windowsHide: true, timeout: 3_000, maxBuffer: 64 * 1024
  });
}

/** Owns an ordinary Chrome process, not a Playwright connection or debugging port. */
export async function createNativeChrome(profile, {
  findExecutable = findNativeChrome,
  spawnProcess = spawn,
  probeProfile = probeChromeProfileUsage,
  requestClose = requestNativeClose,
  platform = process.platform,
  initialUrl = 'about:blank',
  pollMs = 250,
  pause = sleep,
  now = Date.now,
  signal
} = {}) {
  const directory = profile?.userDataDir;
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw nativeError('PROFILE_PATH_UNAVAILABLE', 'An absolute Chrome Profile path is required');
  }
  if (signal?.aborted) throw signal.reason;
  const before = await probeProfile(directory).catch(() => 'unknown');
  if (before !== 'inactive') {
    throw nativeError('PROFILE_IN_USE', 'The Profile is already open or its process ownership cannot be confirmed');
  }
  const executable = await findExecutable();
  if (signal?.aborted) throw signal.reason;
  const child = spawnProcess(executable, [`--user-data-dir=${directory}`, '--no-first-run', '--new-window', initialUrl], {
    // Keep Chrome in the supervisor's process tree for the Manager's bounded cleanup.
    detached: false, windowsHide: true, stdio: 'ignore', shell: false
  });
  let exited = false;
  let spawnError;
  child.once('exit', () => { exited = true; });
  child.once('error', (error) => { spawnError = error; exited = true; });
  const hasExited = () => exited || child.exitCode !== null || child.signalCode !== null;
  const inactive = async () => hasExited() && await probeProfile(directory).catch(() => 'unknown') === 'inactive';

  return {
    async ready({ timeoutMs = 60_000, signal: readySignal } = {}) {
      const deadline = now() + timeoutMs;
      while (now() < deadline) {
        if (readySignal?.aborted) throw readySignal.reason;
        if (spawnError || hasExited()) throw nativeError('CHROME_LAUNCH_FAILED', 'Chrome exited before its Profile opened', spawnError);
        const usage = await probeProfile(directory).catch(() => 'unknown');
        if (usage === 'active' && !hasExited()) return;
        await pause(pollMs);
      }
      throw nativeError('CHROME_LAUNCH_FAILED', 'Chrome did not open its Profile in time');
    },
    async waitForClose(waitSignal) {
      while (!waitSignal?.aborted) {
        if (await inactive()) return;
        await pause(pollMs);
      }
    },
    async close({ timeoutMs = 8_000 } = {}) {
      const deadline = now() + timeoutMs;
      while (now() < deadline) {
        if (await inactive()) return true;
        if (!hasExited()) await requestClose(child, platform).catch(() => {});
        await pause(pollMs);
      }
      // A launcher exit alone is not proof: another Chrome may still own this directory.
      return inactive();
    }
  };
}
