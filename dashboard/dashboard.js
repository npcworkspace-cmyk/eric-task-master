const MODES = ['fast', 'human', 'adaptive'];
const ACTIVE_TASK_STATES = new Set(['queued', 'acquiring_profile', 'starting_browser', 'running', 'cooling_down', 'recovering', 'verifying']);
const ATTENTION_TASK_STATES = new Set(['waiting_user', 'failed']);
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);
const TOKEN_KEY = 'taskmaster.dashboardToken';

const ui = Object.freeze({
  connectionDot: document.querySelector('#connection-dot'),
  connectionLabel: document.querySelector('#connection-label'),
  tokenPanel: document.querySelector('#token-panel'),
  tokenForm: document.querySelector('#token-form'),
  managerToken: document.querySelector('#manager-token'),
  refreshAll: document.querySelector('#refresh-all'),
  profileCount: document.querySelector('#profile-count'),
  runningCount: document.querySelector('#running-count'),
  attentionCount: document.querySelector('#attention-count'),
  createProfileForm: document.querySelector('#create-profile-form'),
  profileName: document.querySelector('#profile-name'),
  profileMode: document.querySelector('#profile-mode'),
  profileHeadless: document.querySelector('#profile-headless'),
  profiles: document.querySelector('#profiles'),
  tasks: document.querySelector('#tasks'),
  lastRefresh: document.querySelector('#last-refresh'),
  message: document.querySelector('#dashboard-message'),
  resultDialog: document.querySelector('#task-result-dialog'),
  resultTitle: document.querySelector('#result-title'),
  resultSummary: document.querySelector('#result-summary'),
  resultEvidence: document.querySelector('#result-evidence'),
  resultOutputRow: document.querySelector('#result-output-row'),
  resultOutput: document.querySelector('#result-output')
});

let managerToken = '';
let profiles = [];
let tasks = [];
let refreshTimer = null;

function consumeCodeFromLocation() {
  const url = new URL(location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const supplied = hash.get('code');
  if (supplied) {
    url.hash = '';
    history.replaceState(null, '', `${url.pathname}${url.search}`);
  }
  return supplied || '';
}

function setMessage(message = '', kind = '') {
  ui.message.textContent = message;
  ui.message.className = `message ${kind}`.trim();
}

function setConnected(connected) {
  ui.connectionDot.className = `dot ${connected ? 'connected' : 'disconnected'}`;
  ui.connectionLabel.textContent = connected ? '本机 Manager 已连接' : 'Manager 未连接';
  ui.tokenPanel.classList.toggle('hidden', connected);
}

async function request(path, { method = 'GET', body } = {}) {
  if (!managerToken) throw Object.assign(new Error('需要 Manager 令牌'), { status: 401 });
  const response = await fetch(path, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${managerToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error?.message || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function exchangeDashboardCode(code) {
  const response = await fetch('/v1/dashboard/session', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.dashboardToken !== 'string') {
    throw new Error(payload?.error?.message || 'Dashboard 授权短码无效或已过期');
  }
  managerToken = payload.dashboardToken;
  sessionStorage.setItem(TOKEN_KEY, managerToken);
}

function unpackList(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, action) {
  const node = element('button', `button small ${className}`.trim(), label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function profileState(profile) {
  return profile.status || profile.state || 'idle';
}

function profileMode(profile) {
  const value = profile.defaultBehavior || profile.behavior || profile.behaviorMode;
  return MODES.includes(value) ? value : 'fast';
}

function renderProfiles() {
  ui.profiles.replaceChildren();
  for (const profile of profiles) {
    const card = element('article', 'profile-card');
    const top = element('div', 'profile-top');
    top.append(
      element('h3', '', profile.name),
      element('span', `state-pill ${profileState(profile)}`, profileState(profile))
    );
    const meta = element('p', 'profile-meta', `ID ${profile.id} · 最后使用 ${formatTime(profile.lastUsedAt)}`);
    const controls = element('div', 'profile-controls');
    const mode = document.createElement('select');
    mode.title = '默认行为模式';
    for (const value of MODES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = { fast: '快速', human: '拟人', adaptive: '自适应' }[value];
      mode.append(option);
    }
    mode.value = profileMode(profile);
    mode.addEventListener('change', () => updateProfile(profile.id, { defaultBehavior: mode.value }));

    const headless = element('label', 'checkbox-label');
    headless.title = '不显示 Playwright 浏览器窗口';
    const headlessInput = document.createElement('input');
    headlessInput.type = 'checkbox';
    headlessInput.checked = Boolean(profile.headless);
    headlessInput.addEventListener('change', () => updateProfile(profile.id, { headless: headlessInput.checked }));
    headless.append(headlessInput, '后台运行');

    const isOpen = ['open', 'leased', 'starting'].includes(profileState(profile));
    const rename = button('改名', 'ghost', () => renameProfile(profile));
    const toggle = button(isOpen ? '关闭' : '打开', '', () => setProfileOpen(profile, !isOpen));
    const remove = button('删除', 'danger', () => deleteProfile(profile));
    remove.disabled = profileState(profile) !== 'idle';
    controls.append(mode, headless, rename, toggle, remove);
    card.append(top, meta, controls);
    ui.profiles.append(card);
  }
  if (!profiles.length) ui.profiles.append(element('p', 'empty', '还没有 Profile。创建一个独立环境开始任务。'));
}

function taskProgress(task) {
  const current = Number(task.progress?.current ?? 0);
  const total = Number(task.progress?.total ?? 0);
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round(current / total * 100))) : 0;
  return { current, total, percent, message: task.progress?.message || '' };
}

function resultUrl(task) {
  const candidate = task.resultUrl || task.outputUrl || task.result?.url;
  if (typeof candidate !== 'string' || !candidate) return '';
  try {
    const url = new URL(candidate, location.origin);
    return url.origin === location.origin ? url.href : '';
  } catch {
    return '';
  }
}

function renderTasks() {
  ui.tasks.replaceChildren();
  for (const task of tasks) {
    const row = document.createElement('tr');
    const name = element('td', 'task-name', task.name || task.meta?.name || task.id);
    const profile = element('td', '', task.profileName || task.profileId || '—');
    const status = element('td', 'task-status', task.state || task.status || 'unknown');
    const progress = taskProgress(task);
    const progressCell = element('td', 'progress');
    const track = element('div', 'progress-track');
    const fill = element('div', 'progress-fill');
    fill.style.width = `${progress.percent}%`;
    track.append(fill);
    const progressCopy = element('div', 'progress-copy');
    progressCopy.append(
      element('span', '', progress.message || `${progress.current}/${progress.total || '?'}`),
      element('span', '', `${progress.percent}%`)
    );
    progressCell.append(track, progressCopy);
    const heartbeat = element('td', 'muted', formatTime(task.lastHeartbeatAt || task.heartbeatAt || task.updatedAt));
    const actions = element('td', 'row-actions');
    const state = task.state || task.status;
    const cancel = button('取消', 'danger', () => cancelTask(task));
    cancel.disabled = TERMINAL_TASK_STATES.has(state);
    actions.append(cancel);
    if (task.result || task.outputRef) {
      actions.append(button('查看结果', '', () => showTaskResult(task)));
    }
    const output = resultUrl(task);
    if (output) {
      const link = element('a', 'result-link', '结果 ↗');
      link.href = output;
      link.target = '_blank';
      link.rel = 'noreferrer';
      actions.append(link);
    }
    row.append(name, profile, status, progressCell, heartbeat, actions);
    ui.tasks.append(row);
  }
  if (!tasks.length) {
    const row = document.createElement('tr');
    const cell = element('td', 'empty', '当前没有任务');
    cell.colSpan = 6;
    row.append(cell);
    ui.tasks.append(row);
  }
}

async function showTaskResult(task) {
  ui.resultTitle.textContent = task.name || task.meta?.name || task.id;
  ui.resultSummary.textContent = task.result?.summary || (task.state === 'completed' ? '任务已完成。' : '任务尚未返回摘要。');
  const evidence = task.result?.evidence ?? task.result ?? [];
  ui.resultEvidence.textContent = JSON.stringify(evidence, null, 2);
  let artifacts = [];
  try {
    const payload = await request(`/v1/tasks/${encodeURIComponent(task.id)}/artifacts`);
    artifacts = unpackList(payload, 'artifacts');
  } catch (error) {
    setMessage(error.message, 'error');
  }
  ui.resultOutputRow.classList.toggle('hidden', artifacts.length === 0);
  ui.resultOutput.textContent = artifacts
    .map((artifact) => `${artifact.name} · ${artifact.sizeBytes} bytes · ${artifact.mimeType}`)
    .join('\n');
  ui.resultDialog.showModal();
}

function updateSummary() {
  ui.profileCount.textContent = String(profiles.length);
  ui.runningCount.textContent = String(tasks.filter((task) => ACTIVE_TASK_STATES.has(task.state || task.status)).length);
  ui.attentionCount.textContent = String(tasks.filter((task) => ATTENTION_TASK_STATES.has(task.state || task.status)).length);
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

async function refresh() {
  if (!managerToken) {
    setConnected(false);
    return;
  }
  try {
    const [profilePayload, taskPayload] = await Promise.all([
      request('/v1/profiles'),
      request('/v1/tasks')
    ]);
    profiles = unpackList(profilePayload, 'profiles');
    tasks = unpackList(taskPayload, 'tasks');
    renderProfiles();
    renderTasks();
    updateSummary();
    ui.lastRefresh.textContent = `刷新于 ${formatTime(new Date())}`;
    setConnected(true);
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      managerToken = '';
      sessionStorage.removeItem(TOKEN_KEY);
    }
    setConnected(false);
    setMessage(error.message, 'error');
  }
}

async function createProfile(event) {
  event.preventDefault();
  const name = ui.profileName.value.trim();
  if (!name) return;
  try {
    await request('/v1/profiles', {
      method: 'POST',
      body: { name, defaultBehavior: ui.profileMode.value, headless: ui.profileHeadless.checked }
    });
    ui.profileName.value = '';
    ui.profileHeadless.checked = false;
    setMessage('Profile 已创建', 'success');
    await refresh();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function updateProfile(id, patch) {
  try {
    await request(`/v1/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
    await refresh();
  } catch (error) {
    setMessage(error.message, 'error');
    await refresh();
  }
}

async function renameProfile(profile) {
  const name = prompt('新的 Profile 名称', profile.name)?.trim();
  if (name && name !== profile.name) await updateProfile(profile.id, { name });
}

async function setProfileOpen(profile, shouldOpen) {
  try {
    await request(`/v1/profiles/${encodeURIComponent(profile.id)}/${shouldOpen ? 'open' : 'close'}`, { method: 'POST' });
    setMessage(shouldOpen ? 'Profile 正在打开' : 'Profile 已关闭', 'success');
    await refresh();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function deleteProfile(profile) {
  if (!confirm(`删除 Profile “${profile.name}”？其持久化浏览器数据将被清理。`)) return;
  try {
    await request(`/v1/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
    setMessage('Profile 已删除', 'success');
    await refresh();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function cancelTask(task) {
  if (!confirm(`取消任务 “${task.name || task.id}”？`)) return;
  try {
    await request(`/v1/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST' });
    setMessage('取消请求已发送', 'success');
    await refresh();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function saveToken(event) {
  event.preventDefault();
  const code = ui.managerToken.value.trim();
  ui.managerToken.value = '';
  if (!code) return;
  try {
    await exchangeDashboardCode(code);
    await refresh();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

const initialCode = consumeCodeFromLocation();
managerToken = sessionStorage.getItem(TOKEN_KEY) || '';
ui.tokenForm.addEventListener('submit', saveToken);
ui.createProfileForm.addEventListener('submit', createProfile);
ui.refreshAll.addEventListener('click', refresh);
void (async () => {
  if (initialCode) {
    try {
      await exchangeDashboardCode(initialCode);
    } catch (error) {
      setMessage(error.message, 'error');
    }
  }
  await refresh();
})();
refreshTimer = setInterval(() => void refresh(), 5000);
window.addEventListener('pagehide', () => clearInterval(refreshTimer), { once: true });
