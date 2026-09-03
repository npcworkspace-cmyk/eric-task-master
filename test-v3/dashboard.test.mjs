import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function text(relative) {
  return readFile(new URL(relative, root), 'utf8');
}

test('v3 Dashboard is a two-page task and Profile control surface', async () => {
  const [html, source, css] = await Promise.all([
    text('dashboard/index.html'),
    text('dashboard/dashboard.js'),
    text('dashboard/styles.css')
  ]);

  const views = [...html.matchAll(/data-view="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(views, ['tasks', 'profiles']);
  for (const id of [
    'view-tasks', 'tasks', 'tasks-error', 'view-profiles', 'profiles', 'profiles-error',
    'create-profile-form', 'profile-name', 'connection-label', 'refresh-all'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`, 'u'));
  }
  for (const removed of [
    'view-assets', 'view-settings', 'notification-drawer', 'task-select-all',
    'profile-kind', 'profile-engine', 'profile-mode', 'profile-headless', 'logout-button'
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${removed}"`, 'u'));
  }

  for (const endpoint of ['/v1/status', '/v1/tasks', '/v1/profiles']) {
    assert.ok(source.includes(endpoint), `Dashboard must use ${endpoint}`);
  }
  for (const removedPath of ['/v1/task-assets', '/v1/notifications', '/v1/notification-settings', '/v1/dashboard/session']) {
    assert.equal(source.includes(removedPath), false, `Dashboard must not use ${removedPath}`);
  }
  assert.match(source, /body:\s*\{ action \}/u);
  assert.match(source, /body:\s*\{ isDefault: true \}/u);
  assert.match(source, /method:\s*'DELETE'/u);
  assert.match(source, /state\.pending\.has\(key\)/u);
  assert.match(source, /credentials:\s*'same-origin'/u);
  assert.match(source, /READ_REQUEST_TIMEOUT_MS = 10_000/u);
  assert.match(source, /MUTATION_REQUEST_TIMEOUT_MS = 60_000/u);
  assert.match(source, /upperMethod === 'GET' \? READ_REQUEST_TIMEOUT_MS : MUTATION_REQUEST_TIMEOUT_MS/u);
  assert.match(source, /永久删除该任务记录和 Manager 内的全部产物/u);
  assert.match(source, /permanently removes the task record and every artifact stored by Manager/u);
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|new Function|fetch\(['"]https?:\/\//u);

  const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
  assert.match(css, /:focus-visible/u);
  assert.match(css, /min-height:\s*44px/u);
  assert.match(css, /prefers-reduced-motion:\s*reduce/u);
  assert.match(css, /@media \(max-width:\s*560px\)/u);
  assert.match(css, /--npc-paper:/u);
  assert.match(css, /--npc-signal:/u);
});

test('portable Skill contains only one CLI guide and its license', async () => {
  const skillRoot = new URL('../skills/eric-task-master/', import.meta.url);
  const entries = (await readdir(skillRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(entries, ['LICENSE', 'SKILL.md']);

  const skill = await readFile(new URL('SKILL.md', skillRoot), 'utf8');
  assert.match(skill, /^---\nname: eric-task-master\n/);
  assert.match(skill, /taskmaster run \.\/job\.mjs/u);
  assert.match(skill, /taskmaster follow TASK_ID/u);
  assert.match(skill, /taskmaster stop TASK_ID/u);
  assert.match(skill, /taskmaster resume TASK_ID/u);
  assert.match(skill, /taskmaster delete TASK_ID/u);
  assert.match(skill, /Do not add a preflight check to a normal task/u);
  assert.doesNotMatch(skill, /task type|surface-probe|full-human|journey|ephemeral/iu);
  assert.ok(skill.split(/\r?\n/u).length <= 70, 'Skill should stay one-page and cheap to read');
});
