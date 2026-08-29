import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('task panel exposes Tasks, Profiles, and bounded Task Pack assets with accessible controls', async () => {
  const [html, css] = await Promise.all([
    text('dashboard/index.html'),
    text('dashboard/styles.css')
  ]);

  for (const id of [
    'view-tasks', 'view-profiles', 'view-assets', 'tasks', 'profiles', 'assets',
    'tasks-error', 'profiles-error', 'assets-error', 'asset-search', 'asset-filter', 'asset-select-all'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const removed of [
    'view-overview', 'view-agents', 'agents', 'task-detail-dialog', 'task-report',
    'task-timeline', 'task-artifacts', 'task-command-form', 'developer-diagnostics'
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${removed}"`));
  }
  const views = [...html.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(views, ['tasks', 'profiles', 'assets']);
  assert.match(html, /id="view-tasks" class="view is-active"/);
  assert.match(html, /href="#main-content"/);
  assert.match(html, /<nav[^>]+aria-label="主要导航"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /href="\/dashboard\/styles\.css"/);
  assert.doesNotMatch(html, /(?:manager token|dashboard token|配对码|授权码|端口|localhost|127\.0\.0\.1)/i);

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');

  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /@media \(max-width:\s*560px\)/);
  assert.match(css, /--npc-paper:/);
  assert.match(css, /--npc-signal:/);
});

test('task panel keeps bounded same-origin reads, concurrency guards, task timing, and safe batch assets', async () => {
  const [html, source] = await Promise.all([
    text('dashboard/index.html'),
    text('dashboard/dashboard.js')
  ]);

  const selectors = [...source.matchAll(/document\.querySelector\('#([^']+)'\)/g)].map((match) => match[1]);
  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  for (const selector of selectors) {
    assert.ok(htmlIds.has(selector), `#${selector} must exist in dashboard/index.html`);
  }

  assert.match(source, /const REQUEST_TIMEOUT_MS = 10_000/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /credentials:\s*'same-origin'/);
  assert.match(source, /request\('\/v1\/dashboard\/session'/);
  assert.match(source, /history\.replaceState\(null, '', `\$\{location\.pathname\}\$\{location\.search\}`\)/);
  assert.match(source, /const mayRetry = upperMethod === 'GET'/);
  assert.match(source, /const attempts = mayRetry \? 2 : 1/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /sequence !== state\.refreshSequence/);
  assert.match(source, /containsInteractiveFocus/);
  assert.match(source, /document\.visibilityState === 'hidden'/);
  assert.match(source, /window\.addEventListener\('pagehide'/);
  assert.match(source, /window\.addEventListener\('pageshow'/);
  assert.match(source, /window\.addEventListener\('popstate'/);

  for (const path of ['/v1/profiles', '/v1/tasks', '/v1/task-assets', '/v1/dashboard/logout']) {
    assert.ok(source.includes(path), `Dashboard must call ${path}`);
  }
  for (const removedPath of ['/v1/agents', '/v1/dashboard/summary', '/artifacts', '/timeline', '/commands', '/continue']) {
    assert.equal(source.includes(removedPath), false, `Dashboard must not call ${removedPath}`);
  }

  assert.match(source, /\/actions`/);
  assert.match(source, /method:\s*'DELETE'/);
  assert.match(source, /body:\s*\{ commandId: commandId\(\), expectedRevision: task\.revision \}/);
  assert.match(source, /body:\s*\{ action, commandId: commandId\(\), expectedRevision: task\.revision \}/);
  assert.match(source, /error\.status === 409/);
  assert.match(source, /状态已变化，已刷新最新状态/);
  assert.match(source, /error\.status === 403/);
  assert.match(source, /state\.pendingMutations\.has\(key\)/);
  assert.match(source, /focusIntentSequence === state\.focusIntentSequence/);
  assert.match(source, /displayName \|\| task\?\.name \|\| task\?\.taskLabel/);
  assert.match(source, /timing\.runDurationMs/);
  assert.match(source, /timing\.cooldownDurationMs/);
  assert.match(source, /timing\.totalDurationMs/);
  assert.match(source, /scheduleDurationTick/);
  assert.match(source, /data-task-duration/);
  assert.match(source, /cleanup\?\.settled === true/);
  assert.match(source, /quarantinedEphemeral/);
  assert.match(source, /清理残留/);
  assert.match(source, /任务清理未确认/);
  assert.match(source, /仅任务启动/);
  assert.match(source, /确定取消任务/);
  assert.match(source, /确定删除任务记录/);
  assert.match(source, /focusAfter/);
  assert.match(source, /runAssetAction/);
  assert.match(source, /assetIds/);

  assert.doesNotMatch(source, /ownerAgentName|taskAgent\(|agentName\(/);
  assert.doesNotMatch(source, /sessionStorage|localStorage|['"]Authorization['"]/i);
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|eval\(|new Function/);
  assert.doesNotMatch(source, /fetch\(['"]https?:\/\//);
  assert.doesNotMatch(source, /setInterval/);
  assert.doesNotMatch(source, /console\.(?:log|info|debug|warn|error)/);
});
