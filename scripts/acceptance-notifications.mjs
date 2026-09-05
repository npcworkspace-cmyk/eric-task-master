#!/usr/bin/env node
// Optional native desktop smoke: intentionally sends only ONE notification.
// Unit tests exercise the full 20-minute schedule without spamming the desktop.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  NOTIFICATION_APP_ID, runNotificationCommand, sendDesktopNotification
} from '../src/lib/desktop-notifications.mjs';

if (!process.argv.includes('--live')) {
  process.stdout.write(`${JSON.stringify({ skipped: true, reason: 'Use --live to submit one native desktop notification' })}\n`);
} else {
  const tag = randomBytes(8).toString('hex');
  const result = await sendDesktopNotification({
    title: 'Eric Task Master · 通知验收',
    body: '这是一次系统通知验收。正式任务遇到验证时立即提醒，此后每 30 秒提醒，恢复或等待 20 分钟自动暂停后停止。',
    tag, expiresAt: new Date(Date.now() + 30_000).toISOString()
  });
  assert.equal(result.submitted, true);
  let historyMatched = null;
  if (process.platform === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$history = [Windows.UI.Notifications.ToastNotificationManager]::History
$matches = @($history.GetHistory('${NOTIFICATION_APP_ID}') | Where-Object { $_.Tag -eq '${tag}' -and $_.Group -eq 'verification' })
if ($matches.Count -ne 1) { throw 'Submitted notification was not found in Windows notification history' }
$history.Remove('${tag}', 'verification', '${NOTIFICATION_APP_ID}')
[Console]::Out.WriteLine('history-matched')
`;
    const check = await runNotificationCommand('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
    ]);
    historyMatched = check.stdout.trim() === 'history-matched';
    assert.equal(historyMatched, true);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true, platform: process.platform, submitted: true, historyMatched,
    visiblePopupVerified: false, notificationsSent: 1
  })}\n`);
}
