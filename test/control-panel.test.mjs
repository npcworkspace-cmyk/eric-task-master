import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('Owner Console exposes the four work areas and accessible task controls', async () => {
  const [html, css] = await Promise.all([
    text('dashboard/index.html'),
    text('dashboard/styles.css')
  ]);

  for (const id of ['view-overview', 'view-agents', 'view-profiles', 'view-tasks']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const id of [
    'agents', 'profiles', 'tasks', 'task-detail-dialog', 'task-report',
    'task-pause', 'task-resume', 'task-terminate', 'task-modify', 'task-ask',
    'task-timeline', 'task-artifacts', 'developer-diagnostics', 'task-detail-error'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(html, /href="#main-content"/);
  assert.match(html, /<nav[^>]+aria-label="主要导航"/);
  assert.match(html, /<dialog[^>]+aria-labelledby="task-detail-title"/);
  assert.match(html, /<details class="developer-details">/);
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

test('Owner Console uses cookie auth, bounded reads, durable commands, and stale-response guards', async () => {
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
  assert.match(source, /sequence !== state\.detailSequence/);
  assert.match(source, /containsInteractiveFocus/);
  assert.match(source, /document\.visibilityState === 'hidden'/);
  assert.match(source, /window\.addEventListener\('pagehide'/);
  assert.match(source, /window\.addEventListener\('pageshow'/);
  assert.match(source, /window\.addEventListener\('popstate'/);

  for (const path of [
    '/v1/dashboard/summary', '/v1/agents', '/v1/profiles', '/v1/tasks',
    '/v1/dashboard/logout'
  ]) {
    assert.ok(source.includes(path), `Dashboard must call ${path}`);
  }
  assert.match(source, /\/actions`/);
  assert.match(source, /\/commands`/);
  assert.match(source, /commandId:\s*commandId\(\)/);
  assert.match(source, /expectedRevision:\s*task\.revision/);
  assert.match(source, /error\.status === 409/);
  assert.match(source, /状态已变化，已刷新最新状态/);
  assert.match(source, /error\.status === 403/);
  assert.match(source, /setInlineError\(ui\.taskDetailError/);
  assert.match(source, /agent\.connectionCount \?\? agent\.activeConnectionCount/);
  assert.match(source, /isAgentActionLocked\(id\)/);
  assert.match(source, /focusIntentSequence === state\.focusIntentSequence/u);
  assert.match(source, /state\.pendingFocusKey === activeFocusKey/u);
  assert.match(source, /恢复“\$\{agentName\(agent\)\}”接入 Manager 的权限/);
  assert.match(source, /state\.tasks = \[\]/);
  assert.match(source, /ui\.taskReport\.replaceChildren\(\)/);
  assert.match(source, /task\.userRequest\?\.id/);
  assert.match(source, /\/continue`/);
  assert.match(source, /for \(const section of report\.sections\)/);

  assert.doesNotMatch(source, /sessionStorage|localStorage|['"]Authorization['"]/i);
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|eval\(|new Function/);
  assert.doesNotMatch(source, /fetch\(['"]https?:\/\//);
  assert.doesNotMatch(source, /setInterval/);
  assert.doesNotMatch(source, /console\.(?:log|info|debug|warn|error)/);
});
