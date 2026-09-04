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
  assert.match(source, /rename\.disabled = pending \|\| status === 'inUse'/u);
  assert.match(source, /prompt\(t\('profiles\.renamePrompt'\), profile\.name \|\| ''\)\?\.trim\(\)/u);
  assert.match(source, /if \(!name \|\| name === profile\.name\) return/u);
  assert.match(source, /'profiles\.rename': '改名'/u);
  assert.match(source, /'profiles\.rename': 'Rename'/u);
  assert.match(source, /method:\s*'DELETE'/u);
  assert.match(source, /state\.pending\.has\(key\)/u);
  assert.match(source, /credentials:\s*'same-origin'/u);
  assert.match(source, /READ_REQUEST_TIMEOUT_MS = 10_000/u);
  assert.match(source, /MUTATION_REQUEST_TIMEOUT_MS = 60_000/u);
  assert.match(source, /PROFILE_OPEN_REQUEST_TIMEOUT_MS = 100_000/u);
  assert.match(source, /action === 'open' \? PROFILE_OPEN_REQUEST_TIMEOUT_MS : MUTATION_REQUEST_TIMEOUT_MS/u);
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
  assert.match(skill, /%LOCALAPPDATA%\\Programs\\Eric Task Master\\bin\\taskmaster\.cmd/u);
  assert.match(skill, /macOS `\/usr\/local\/bin\/taskmaster`; Linux `\/usr\/bin\/taskmaster`/u);
  assert.doesNotMatch(skill, /task type|surface-probe|full-human|journey|ephemeral/iu);
  assert.ok(skill.split(/\r?\n/u).length <= 70, 'Skill should stay one-page and cheap to read');
});

test('cleanup is one accessible dialog with opt-in historical output and matching-preview confirmation', async () => {
  const [html, source, css, acceptance] = await Promise.all([
    text('dashboard/index.html'), text('dashboard/dashboard.js'), text('dashboard/styles.css'),
    text('scripts/dashboard-acceptance.mjs')
  ]);
  assert.equal([...html.matchAll(/<dialog\b/gu)].length, 1);
  assert.match(html, /<dialog[^>]+id="cleanup-dialog"[^>]+aria-labelledby="cleanup-title"[^>]+aria-describedby="cleanup-safety"/u);
  assert.match(html, /id="open-cleanup"[^>]+aria-haspopup="dialog"/u);
  const checkboxes = [...html.matchAll(/<input type="checkbox" name="cleanup-category" value="([^"]+)"([^>]*)>/gu)];
  assert.deepEqual(checkboxes.map((match) => [match[1], /\bchecked\b/u.test(match[2])]), [
    ['browser-cache', true], ['temporary-files', true], ['task-output', false]
  ]);
  assert.match(html, /id="confirm-cleanup"[^>]+disabled/u);
  assert.match(source, /previewKey !== categories\.join\(','\)/u);
  assert.match(source, /sequence !== cleanup\.sequence/u);
  assert.match(source, /await cleanup\.previewRequest\?\.catch/u);
  assert.match(source, /body: \{ categories, preview: true \}/u);
  assert.match(source, /body: \{ categories, preview: false \}/u);
  assert.match(source, /cleanup\.executing \|\| cleanup\.loading/u);
  assert.match(source, /cleanup\.preview = null/u);
  assert.match(source, /cleanupDialog\.addEventListener\('cancel'/u);
  assert.match(source, /'cleanup\.open': '清理空间'/u);
  assert.match(source, /'cleanup\.open': 'Clean up space'/u);
  assert.match(source, /'cleanup\.freed': '已清理文件大小'/u);
  assert.match(source, /'cleanup\.freed': 'Deleted file size'/u);
  assert.match(source, /cleanup\.reason\.BROWSER_OPEN/u);
  assert.match(css, /\.cleanup-dialog::backdrop/u);
  assert.match(css, /max-height: calc\(100dvh - 32px\)/u);
  assert.match(css, /\.cleanup-option[^}]+min-height: 44px/u);
  for (const evidence of ['historicalOutputPresent', 'previewHeld', 'failPreview', 'failExecution', 'cleanupScreenshotPaths']) {
    assert.ok(acceptance.includes(evidence), `Browser acceptance must cover ${evidence}`);
  }
});
