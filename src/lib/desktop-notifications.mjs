import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { redactPublicText } from './redaction.mjs';

const executeFile = promisify(execFile);
export const NOTIFICATION_APP_ID = 'NPCWorkspace.EricTaskMaster';
export const VERIFICATION_NOTIFICATION_INTERVAL_MS = 30_000;
export const VERIFICATION_NOTIFICATION_TIMEOUT_MS = 20 * 60_000;

// No shell interpolation, visible console, or unbounded child lifetime. The
// notifier is always a side effect; callers must never await it to run a task.
export async function runNotificationCommand(command, args, { signal, timeoutMs = 10_000 } = {}) {
  try {
    return await executeFile(command, args, {
      windowsHide: true, shell: false, timeout: timeoutMs, killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024, encoding: 'utf8', signal
    });
  } catch (error) {
    // execFile includes the full encoded payload in its default error message.
    // Keep diagnostic status without logging the notification or command line.
    throw Object.assign(new Error(`Desktop notification helper failed (${error.code ?? error.signal ?? 'unknown'})`), {
      code: error.code ?? 'NOTIFICATION_COMMAND_FAILED', signal: error.signal,
      killed: error.killed, stderr: String(error.stderr ?? '').slice(-4_096)
    });
  }
}

function windowsScript(payload, register) {
  // Task text is data inside an encoded JSON envelope, never PowerShell code.
  const encoded = Buffer.from(JSON.stringify({
    ...payload,
    ...(register ? { executable: process.execPath, cliPath: fileURLToPath(new URL('../cli.mjs', import.meta.url)) } : {})
  }), 'utf8').toString('base64');
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$appId = '${NOTIFICATION_APP_ID}'
${register ? `
$registrationPath = 'HKCU:\\Software\\Classes\\AppUserModelId\\${NOTIFICATION_APP_ID}'
New-Item -Path $registrationPath -Force | Out-Null
New-ItemProperty -Path $registrationPath -Name DisplayName -Value 'Eric Task Master' -PropertyType ExpandString -Force | Out-Null
# Unpackaged desktop apps also need a Start Menu shortcut carrying the AUMID.
# Installers register their main shortcut. This dedicated lazy shortcut lets
# source/portable runs work too, without any mandatory task startup check.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TaskMasterToastShortcut {
  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey { public Guid format; public uint id; }
  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyValue {
    public ushort type, reserved1, reserved2, reserved3;
    public IntPtr value, reserved4;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    void GetCount(out uint count);
    void GetAt(uint index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropertyValue value);
    void SetValue(ref PropertyKey key, ref PropertyValue value);
    void Commit();
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bind,
    uint flags, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
  public static void Register(string path, string appId) {
    Guid iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out store);
    var key = new PropertyKey { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), id = 5 };
    var value = new PropertyValue { type = 31, value = Marshal.StringToCoTaskMemUni(appId) };
    try { store.SetValue(ref key, ref value); store.Commit(); }
    finally { Marshal.FreeCoTaskMem(value.value); Marshal.FinalReleaseComObject(store); }
  }
}
'@
$shortcutFolder = Join-Path ([Environment]::GetFolderPath('Programs')) 'Eric Task Master'
New-Item -ItemType Directory -Path $shortcutFolder -Force | Out-Null
$shortcutPath = Join-Path $shortcutFolder 'Eric Task Master Notifications.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = [string]$data.executable
$shortcut.Arguments = '"' + [string]$data.cliPath + '" panel'
$shortcut.WorkingDirectory = Split-Path ([string]$data.cliPath)
$shortcut.Description = 'Eric Task Master verification reminders'
$shortcut.WindowStyle = 7
$shortcut.Save()
[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
[TaskMasterToastShortcut]::Register($shortcutPath, $appId)
` : ''}
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotifier, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast duration="short"><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>')
$textNodes = $xml.GetElementsByTagName('text')
$textNodes.Item(0).AppendChild($xml.CreateTextNode([string]$data.title)) | Out-Null
$textNodes.Item(1).AppendChild($xml.CreateTextNode([string]$data.body)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = [string]$data.tag
$toast.Group = 'verification'
$toast.SuppressPopup = $false
$toast.ExpirationTime = [DateTimeOffset]::Parse([string]$data.expiresAt)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$notifier.Show($toast)
[Console]::Out.WriteLine('submitted')
`;
}

export function createDesktopNotificationSender({
  platform = process.platform,
  runCommand = runNotificationCommand,
  commandTimeoutMs = 10_000
} = {}) {
  let windowsRegistered = false;
  return async (payload, { signal } = {}) => {
    if (signal?.aborted) return { submitted: false, reason: 'cancelled' };
    const options = { signal, timeoutMs: commandTimeoutMs };
    if (platform === 'win32') {
      const script = windowsScript(payload, !windowsRegistered);
      await runCommand('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
      ], options);
      windowsRegistered = true;
    } else if (platform === 'darwin') {
      await runCommand('/usr/bin/osascript', ['-e',
        'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run',
        payload.title, payload.body
      ], options);
    } else if (platform === 'linux') {
      await runCommand('notify-send', [
        '--app-name=Eric Task Master', '--expire-time=30000',
        `--hint=string:x-canonical-private-synchronous:${payload.tag}`,
        '--', payload.title, payload.body
      ], options);
    } else {
      return { submitted: false, reason: 'unsupported-platform' };
    }
    // OS submission is observable; user-visible delivery still follows the
    // desktop session's notification permissions and focus settings.
    return { submitted: true, platform };
  };
}

export const sendDesktopNotification = createDesktopNotificationSender();

function notificationFor(task, waitId, timestamp, deadline) {
  const label = redactPublicText(String(task.label || task.name || task.id))
    .replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 120);
  return {
    taskId: task.id,
    waitId,
    title: 'Eric Task Master · 验证待处理',
    body: `任务 ${label} 正在等待人工验证。请处理任务浏览器中的验证并恢复任务；每 30 秒提醒，等待 20 分钟后自动暂停。`,
    tag: createHash('sha256').update(`${task.id}\0${waitId}`).digest('hex').slice(0, 16),
    expiresAt: new Date(Math.min(timestamp + VERIFICATION_NOTIFICATION_INTERVAL_MS, deadline)).toISOString()
  };
}

// One timer and at most one native notification child per active verification
// wait. Screenshots, persistence, resume acknowledgements, and resource cleanup
// neither depend on nor wait for this scheduler.
export function createVerificationNotifier({
  notify = sendDesktopNotification,
  now = Date.now,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout,
  intervalMs = VERIFICATION_NOTIFICATION_INTERVAL_MS,
  timeoutMs = VERIFICATION_NOTIFICATION_TIMEOUT_MS,
  onError = () => {}
} = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Notification interval and timeout must be positive finite milliseconds');
  }
  const waiting = new Map();
  let closed = false;

  function remove(taskId) {
    const entry = waiting.get(taskId);
    if (!entry) return;
    waiting.delete(taskId);
    unschedule(entry.timer);
    entry.controller.abort();
  }

  function report(error, entry) {
    // A log hook is also optional background work; reject/throw cannot reach
    // the Manager or make a later reminder fail.
    if (entry.controller.signal.aborted) return;
    try { Promise.resolve(onError(error, { taskId: entry.task.id, waitId: entry.waitId })).catch(() => {}); }
    catch { /* notification reporting is best effort */ }
  }

  function tick(entry) {
    if (closed || waiting.get(entry.task.id) !== entry) return;
    const timestamp = now();
    if (timestamp >= entry.deadline) {
      remove(entry.task.id);
      return;
    }
    if (!entry.inFlight) {
      entry.inFlight = true;
      // Guard again in the microtask: resume/stop may have arrived before the
      // native child starts. remove() also aborts an already-running child.
      Promise.resolve().then(() => {
        if (waiting.get(entry.task.id) !== entry || entry.controller.signal.aborted || now() >= entry.deadline) return;
        return notify(notificationFor(entry.task, entry.waitId, now(), entry.deadline), {
          signal: entry.controller.signal
        });
      }).catch((error) => report(error, entry)).finally(() => { entry.inFlight = false; });
    }
    // Delayed event loops skip missed ticks rather than burst old reminders.
    const next = entry.startedAt + (Math.floor((timestamp - entry.startedAt) / intervalMs) + 1) * intervalMs;
    entry.timer = schedule(() => tick(entry), Math.max(0, Math.min(next, entry.deadline) - timestamp));
    entry.timer?.unref?.();
  }

  function observeTask(task) {
    if (closed || !task?.id) return;
    if (task.state !== 'waiting' || task.waiting?.kind !== 'verification' ||
        !task.waiting.id || task.waiting.automaticPaused || task.waiting.paused) {
      remove(task.id);
      return;
    }
    const previous = waiting.get(task.id);
    if (previous?.waitId === task.waiting.id) {
      previous.task = task;
      return;
    }
    remove(task.id);
    const timestamp = now();
    const parsedStart = Date.parse(task.waiting.startedAt);
    const startedAt = Number.isFinite(parsedStart) ? Math.min(parsedStart, timestamp) : timestamp;
    const parsedDeadline = Date.parse(task.waiting.pauseAt);
    const deadline = Math.min(startedAt + timeoutMs, Number.isFinite(parsedDeadline) ? parsedDeadline : Infinity);
    if (timestamp >= deadline) return;
    const entry = {
      task, waitId: task.waiting.id, startedAt, deadline, timer: null,
      inFlight: false, controller: new AbortController()
    };
    waiting.set(task.id, entry);
    tick(entry);
  }

  function close() {
    closed = true;
    for (const taskId of waiting.keys()) remove(taskId);
  }

  return { observeTask, remove, close };
}
