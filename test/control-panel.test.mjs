import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('dashboard manages profiles and tasks with refresh, cancel, and same-origin results', async () => {
  const [html, source, css] = await Promise.all([
    text('dashboard/index.html'),
    text('dashboard/dashboard.js'),
    text('dashboard/dashboard.css')
  ]);
  assert.match(html, /id="profiles"/);
  assert.match(html, /id="tasks"/);
  assert.match(html, /id="profile-headless"/);
  assert.match(html, /id="profile-engine"/);
  assert.match(html, /id="task-result-dialog"/);
  assert.match(html, /<th>任务<\/th><th>Agent<\/th><th>Profile<\/th><th>状态<\/th><th>当前活动<\/th><th>业务进度<\/th><th>最近反馈<\/th><th>操作<\/th>/);
  assert.doesNotMatch(html, /(?:manager token|dashboard token|端口|localhost|127\.0\.0\.1|\/v1\/)/i);
  assert.match(source, /request\('\/v1\/profiles'/);
  assert.match(source, /request\('\/v1\/tasks'/);
  assert.match(source, /\/cancel`/);
  assert.match(source, /if \(refreshInFlight\) return refreshInFlight/);
  assert.match(source, /document\.visibilityState === 'hidden'/);
  assert.match(source, /return 10_000/);
  assert.match(source, /return live \? 1_000 : 5_000/);
  assert.match(source, /POLLING_TASK_STATES\.has/);
  assert.match(source, /setTimeout\(async \(\) =>/);
  assert.match(source, /refreshTimer = setTimeout\(async \(\) => \{\s+await refresh\(\)/);
  assert.match(source, /if \(pollingStopped\) return/);
  assert.match(source, /if \(!pollingStopped\) scheduleRefresh\(\)/);
  assert.match(source, /document\.addEventListener\('visibilitychange', scheduleRefresh\)/);
  assert.match(source, /window\.addEventListener\('pagehide'/);
  assert.match(source, /window\.addEventListener\('pageshow'/);
  assert.match(source, /window\.addEventListener\('hashchange'/);
  assert.match(source, /connectFromDashboardCode\(consumeCodeFromLocation\(\)\)/);
  assert.doesNotMatch(source, /setInterval/);
  assert.match(source, /url\.origin === location\.origin/);
  assert.match(source, /showTaskResult\(task\)/);
  assert.match(source, /task\.taskType \|\| '未命名任务'/);
  assert.match(source, /task\.agent\?\.name \|\| task\.agent\?\.clientId \|\| task\.createdBy/);
  assert.match(source, /element\('bdi'/);
  assert.match(source, /`Agent · \$\{task\.agent\.clientId\}`/);
  assert.match(source, /task\.currentActivity \|\| \{\}/);
  assert.match(source, /progress\.message \|\| '等待任务反馈'/);
  assert.match(source, /browserEngine: ui\.profileEngine\.value/);
  assert.match(source, /ui\.profileMode\.disabled = persistent/);
  assert.match(source, /mode\.disabled = !isEphemeral/);
  assert.match(source, /人工打开始终使用可见浏览器窗口/);
  assert.match(source, /sessionStorage\.setItem\(TOKEN_KEY/);
  assert.match(source, /disconnectDashboard\(error\.message\)/);
  assert.match(source, /renderProfiles\(true\)/);
  assert.match(source, /renderTasks\(true\)/);
  assert.match(source, /isInteractingWith\(ui\.profiles\)/);
  assert.match(source, /isInteractingWith\(ui\.tasks\)/);
  assert.match(source, /role', 'progressbar'/);
  assert.match(source, /aria-current', 'true'/);
  assert.match(source, /history\.replaceState/);
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /console\.(?:log|info|debug|warn|error)/);
  assert.match(css, /\.task-focused/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /outline: 2px solid var\(--signal-ink\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(html, /id="profile-count">—</);
  assert.match(html, /连接 Manager 后显示任务/);
});

test('dashboard authorization stays one-time, focused, and same-origin', async () => {
  const source = await text('dashboard/dashboard.js');
  assert.match(source, /fetch\('\/v1\/dashboard\/session'/);
  assert.match(source, /sessionStorage\.setItem\(TOKEN_KEY/);
  assert.match(source, /searchParams\.get\('task'\)/);
  assert.match(source, /TASK_ID_PATTERN\.test\(value\)/);
  assert.match(source, /url\.hash = ''/);
  assert.match(source, /history\.replaceState\(null, '', `\$\{url\.pathname\}\$\{url\.search\}`\)/);
  assert.match(source, /row\.dataset\.taskId = task\.id/);
  assert.match(source, /row\.classList\.add\('task-focused'\)/);
});
