import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('dashboard manages profiles and tasks with refresh, cancel, and same-origin results', async () => {
  const [html, source] = await Promise.all([
    text('dashboard/index.html'),
    text('dashboard/dashboard.js')
  ]);
  assert.match(html, /id="profiles"/);
  assert.match(html, /id="tasks"/);
  assert.match(html, /id="profile-headless"/);
  assert.match(html, /id="task-result-dialog"/);
  assert.match(source, /request\('\/v1\/profiles'/);
  assert.match(source, /request\('\/v1\/tasks'/);
  assert.match(source, /\/cancel`/);
  assert.match(source, /setInterval\(\(\) => void refresh\(\), 5000\)/);
  assert.match(source, /url\.origin === location\.origin/);
  assert.match(source, /showTaskResult\(task\)/);
  assert.match(source, /sessionStorage\.setItem\(TOKEN_KEY/);
  assert.match(source, /history\.replaceState/);
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /console\.(?:log|info|debug|warn|error)/);
});

test('dashboard authorization stays one-time and same-origin', async () => {
  const source = await text('dashboard/dashboard.js');
  assert.match(source, /fetch\('\/v1\/dashboard\/session'/);
  assert.match(source, /sessionStorage\.setItem\(TOKEN_KEY/);
  assert.match(source, /history\.replaceState/);
});
