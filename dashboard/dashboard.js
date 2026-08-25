const MODES = ['fast', 'human', 'adaptive'];
const ACTIVE_TASK_STATES = new Set(['queued', 'acquiring_profile', 'starting_browser', 'running', 'cooling_down', 'recovering', 'verifying']);
const ATTENTION_TASK_STATES = new Set(['waiting_user', 'failed']);
const POLLING_TASK_STATES = new Set(['waiting_user']);
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);
const TOKEN_KEY = 'taskmaster.dashboardToken';
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIVITY_LABELS = Object.freeze({
  queued: '等待调度',
  acquiring_profile: '准备 Profile',
  starting_browser: '启动浏览器',
  running: '执行任务',
  navigating: '打开页面',
  clicking: '点击',
  typing: '输入',
  hovering: '悬停',
  scrolling: '滚动',
  working: '执行动作',
  waiting_user: '等待新指令',
  cooling_down: '限流冷却',
  recovering: '恢复任务',
  verifying: '验证结果',
  cleaning_up: '关闭任务窗口',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
});

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
  profileKind: document.querySelector('#profile-kind'),
  profileEngine: document.querySelector('#profile-engine'),
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
let refreshInFlight = null;
let focusedTaskApplied = false;
let pollingStopped = false;
let dashboardConnected = false;

function focusTaskFromLocation() {
  const value = new URL(location.href).searchParams.get('task');
  return typeof value === 'string' && TASK_ID_PATTERN.test(value) ? value : '';
}

const focusedTaskId = focusTaskFromLocation();

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
  dashboardConnected = connected;
  ui.connectionDot.className = `dot ${connected ? 'connected' : 'disconnected'}`;
  ui.connectionLabel.textContent = connected ? '本机 Manager 已连接' : 'Manager 未连接';
  ui.tokenPanel.classList.toggle('hidden', connected);
  for (const control of ui.createProfileForm.elements) control.disabled = !connected;
  if (connected) syncCreatePolicy();
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
    if (response.status === 401 || response.status === 403) disconnectDashboard(error.message);
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

async function connectFromDashboardCode(code) {
  if (!code) return false;
  try {
    await exchangeDashboardCode(code);
    await refresh({ forceRender: true });
    return true;
  } catch (error) {
    setMessage(error.message, 'error');
    return false;
  }
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

function isInteractingWith(container) {
  const active = document.activeElement;
  return Boolean(active && container.contains(active) && /^(?:A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(active.tagName));
}

function activeTaskRowId() {
  const active = document.activeElement;
  if (!active || active.tagName !== 'TR' || !ui.tasks.contains(active)) return '';
  return active.dataset.taskId || '';
}

function disconnectDashboard(message = '') {
  managerToken = '';
  sessionStorage.removeItem(TOKEN_KEY);
  profiles = [];
  tasks = [];
  setConnected(false);
  renderProfiles(true);
  renderTasks(true);
  updateSummary();
  ui.lastRefresh.textContent = '等待连接';
  ui.resultTitle.textContent = '任务结果';
  ui.resultSummary.textContent = '';
  ui.resultEvidence.textContent = '';
  ui.resultOutput.textContent = '';
  ui.resultOutputRow.classList.add('hidden');
  if (ui.resultDialog.open) ui.resultDialog.close();
  if (message) setMessage(message, 'error');
}

function profileState(profile) {
  return profile.status || profile.state || 'idle';
}

function profileMode(profile) {
  if (profile.kind !== 'ephemeral') return 'human';
  const value = profile.defaultBehavior;
  return MODES.includes(value) ? value : 'adaptive';
}

function profileEngine(profile) {
  return profile.browserEngine === 'chrome' ? '本机稳定版 Chrome' : '项目锁定 Chromium';
}

function syncCreatePolicy() {
  const persistent = ui.profileKind.value === 'persistent';
  ui.profileEngine.value = persistent ? 'chrome' : 'chromium';
  ui.profileMode.value = persistent ? 'human' : 'adaptive';
  ui.profileMode.disabled = persistent;
  ui.profileMode.title = persistent ? '持久 Profile 固定使用拟人行为' : '临时 Profile 的任务行为策略';
}

function renderProfiles(force = false) {
  if (!force && isInteractingWith(ui.profiles)) return;
  ui.profiles.replaceChildren();
  for (const profile of profiles) {
    const card = element('article', 'profile-card');
    const top = element('div', 'profile-top');
    top.append(
      element('h3', '', profile.name),
      element('span', `state-pill ${profileState(profile)}`, profileState(profile))
    );
    const kind = profile.kind === 'ephemeral' ? '隐身临时' : '持久登录';
    const accessLabel = profile.access === 'private'
      ? (profile.createdBy ? '仅创建者 Agent' : '仅管理面板')
      : '本机 Agent 共享';
    const meta = element(
      'p',
      'profile-meta',
      `${kind} · ${profileEngine(profile)} · ${profileMode(profile)} · ${accessLabel} · ID ${profile.id} · 最后使用 ${formatTime(profile.lastUsedAt)}`
    );
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
    const isEphemeral = profile.kind === 'ephemeral';
    mode.disabled = !isEphemeral;
    mode.title = isEphemeral ? '此 Profile 的任务行为策略' : '持久 Profile 固定使用拟人行为';
    if (isEphemeral) {
      mode.addEventListener('change', () => updateProfile(profile.id, { defaultBehavior: mode.value }));
    }

    const headless = element('label', 'checkbox-label');
    headless.title = '仅任务运行时不显示窗口；人工打开持久 Profile 始终可见';
    const headlessInput = document.createElement('input');
    headlessInput.type = 'checkbox';
    headlessInput.checked = Boolean(profile.headless);
    headlessInput.addEventListener('change', () => updateProfile(profile.id, { headless: headlessInput.checked }));
    headless.append(headlessInput, '任务后台');

    const shared = element('label', 'checkbox-label');
    shared.title = '开启后，本机其他已注册 Agent 可以使用此 Profile；任务结果仍相互隔离';
    const sharedInput = document.createElement('input');
    sharedInput.type = 'checkbox';
    sharedInput.checked = profile.access !== 'private';
    sharedInput.addEventListener('change', () => updateProfile(profile.id, {
      access: sharedInput.checked ? 'shared' : 'private'
    }));
    shared.append(sharedInput, 'Agent 共享');

    const isOpen = ['open', 'leased', 'starting'].includes(profileState(profile));
    const rename = button('改名', 'ghost', () => renameProfile(profile));
    const toggle = button(isOpen ? '关闭' : '打开', '', () => setProfileOpen(profile, !isOpen));
    toggle.disabled = isEphemeral;
    toggle.title = isEphemeral
      ? '隐身 Profile 仅在任务中临时启动，结束后自动销毁'
      : '人工打开始终使用可见浏览器窗口';
    const remove = button('删除', 'danger', () => deleteProfile(profile));
    remove.disabled = profileState(profile) !== 'idle';
    controls.append(mode, headless, shared, rename, toggle, remove);
    card.append(top, meta, controls);
    ui.profiles.append(card);
  }
  if (!profiles.length) {
    ui.profiles.append(element(
      'p',
      'empty',
      dashboardConnected ? '还没有 Profile。创建一个独立环境开始任务。' : '连接 Manager 后显示 Profiles。'
    ));
  }
}

function taskProgress(task) {
  const current = Number(task.progress?.current ?? 0);
  const total = Number(task.progress?.total ?? 0);
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round(current / total * 100))) : null;
  let message = task.progress?.message || '';
  if (task.state === 'queued' && task.queuePosition) {
    message = `队列 #${task.queuePosition} · ${task.queueReason || '等待调度'}`;
  }
  if (task.cooldown?.status === 'active') {
    const seconds = Math.max(0, Math.ceil((Date.parse(task.cooldown.resumeAt) - Date.now()) / 1000));
    message = `${task.cooldown.reason || '限流冷却'} · ${seconds}s 后恢复`;
  }
  return { current, total, percent, message, phase: task.progress?.phase || '' };
}

function activityCopy(task) {
  const activity = task.currentActivity || {};
  const phase = typeof activity.phase === 'string' ? activity.phase : (task.state || 'running');
  return {
    label: ACTIVITY_LABELS[phase] || phase.replaceAll('_', ' '),
    status: activity.status || 'active',
    updatedAt: activity.updatedAt || task.updatedAt
  };
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

function renderTasks(force = false) {
  if (!force && isInteractingWith(ui.tasks)) return;
  const taskRowToRefocus = activeTaskRowId();
  ui.tasks.replaceChildren();
  for (const task of tasks) {
    const row = document.createElement('tr');
    row.dataset.taskId = task.id;
    if (task.id === focusedTaskId) {
      row.classList.add('task-focused');
      row.tabIndex = -1;
      row.setAttribute('aria-current', 'true');
      row.setAttribute('aria-label', `当前任务 ${task.taskType || task.id}`);
      if (!focusedTaskApplied) {
        focusedTaskApplied = true;
        queueMicrotask(() => {
          row.focus({ preventScroll: true });
          row.scrollIntoView({ block: 'center' });
        });
      }
    }
    const name = element('td', 'task-name');
    name.append(
      element('strong', '', task.taskType || '未命名任务'),
      element('small', '', task.id)
    );
    const agent = element('td', 'agent-name');
    const agentName = element('strong');
    agentName.append(element('bdi', '', task.agent?.name || task.agent?.clientId || task.createdBy || '本机管理员'));
    agent.append(
      agentName,
      ...(task.agent?.clientId && task.agent?.clientId !== task.agent?.name
        ? [element('small', '', `Agent · ${task.agent.clientId}`)]
        : [])
    );
    const profile = element('td', '', task.profileName || task.profileId || '—');
    const status = element('td', `task-status ${task.health?.status || ''}`);
    status.append(element('strong', '', task.state || task.status || 'unknown'));
    const behavior = task.behaviorState?.effective || task.behavior;
    if (behavior) status.append(element('small', '', `行为 ${behavior}`));
    if (task.health?.status === 'stalled') status.append(element('small', 'warning', '已截图 · 需关注'));
    const activity = activityCopy(task);
    const activityCell = element('td', 'activity-cell');
    activityCell.append(
      element('strong', '', activity.label),
      element('small', `activity-status ${activity.status}`, activity.status),
      element('small', 'muted', formatTime(activity.updatedAt))
    );
    const progress = taskProgress(task);
    const progressCell = element('td', 'progress');
    const track = element('div', 'progress-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', `${task.taskType || task.id} 进度`);
    track.setAttribute('aria-valuemin', '0');
    if (progress.total > 0) {
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(progress.percent));
    } else {
      track.setAttribute('aria-valuetext', '进行中，尚无总量');
    }
    const fill = element('div', 'progress-fill');
    fill.style.width = `${progress.percent ?? 0}%`;
    track.append(fill);
    const progressCopy = element('div', 'progress-copy');
    progressCopy.append(
      element('span', '', progress.phase || `${progress.current}/${progress.total || '?'}`),
      element('span', '', progress.percent === null ? '进行中' : `${progress.percent}%`)
    );
    progressCell.append(track, progressCopy);
    const feedback = element('td', 'latest-feedback');
    feedback.append(
      element('strong', '', progress.message || '等待任务反馈'),
      element('span', '', `心跳 ${formatTime(task.lastHeartbeatAt || task.heartbeatAt || task.updatedAt)}`),
      element('span', '', `进度 ${formatTime(task.progressAt || task.updatedAt)}`)
    );
    const actions = element('td', 'row-actions');
    const state = task.state || task.status;
    const cancel = button('取消', 'danger', () => cancelTask(task));
    cancel.disabled = TERMINAL_TASK_STATES.has(state);
    if (state === 'waiting_user') {
      actions.append(button('继续', 'primary', () => continueTask(task)));
    }
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
    row.append(name, agent, profile, status, activityCell, progressCell, feedback, actions);
    ui.tasks.append(row);
  }
  if (!tasks.length) {
    const row = document.createElement('tr');
    const cell = element('td', 'empty', dashboardConnected ? '当前没有任务' : '连接 Manager 后显示任务。');
    cell.colSpan = 8;
    row.append(cell);
    ui.tasks.append(row);
  }
  if (taskRowToRefocus) {
    const replacement = [...ui.tasks.rows].find((row) => row.dataset.taskId === taskRowToRefocus);
    if (replacement) {
      queueMicrotask(() => {
        if (document.activeElement === document.body) replacement.focus({ preventScroll: true });
      });
    }
  }
}

async function showTaskResult(task) {
  ui.resultTitle.textContent = task.taskType || task.id;
  ui.resultSummary.textContent = task.result?.summary || (task.state === 'completed' ? '任务已完成。' : '任务尚未返回摘要。');
  const evidence = task.result?.evidence ?? task.result ?? [];
  ui.resultEvidence.textContent = JSON.stringify(evidence, null, 2);
  let artifacts = [];
  try {
    const payload = await request(`/v1/tasks/${encodeURIComponent(task.id)}/artifacts`);
    artifacts = unpackList(payload, 'artifacts');
  } catch (error) {
    setMessage(error.message, 'error');
    if (error.status === 401 || error.status === 403) return;
  }
  ui.resultOutputRow.classList.toggle('hidden', artifacts.length === 0);
  ui.resultOutput.textContent = artifacts
    .map((artifact) => `${artifact.name} · ${artifact.sizeBytes} bytes · ${artifact.mimeType}`)
    .join('\n');
  ui.resultDialog.showModal();
}

async function continueTask(task) {
  const handoff = task.userRequest || {};
  const note = prompt(
    `${handoff.reason || '任务正在等待新指令'}\n\n请先查看诊断截图/语义现场并确认当前页面状态；可补充下一步说明：`,
    ''
  );
  if (note === null) return;
  try {
    await request(`/v1/tasks/${encodeURIComponent(task.id)}/continue`, {
      method: 'POST',
      body: {
        ...(handoff.id ? { requestId: handoff.id } : {}),
        ...(note.trim() ? { note: note.trim() } : {})
      }
    });
    setMessage('已发送新指令，任务正在核验当前页面', 'success');
    await refresh({ forceRender: true });
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

function updateSummary() {
  if (!dashboardConnected) {
    ui.profileCount.textContent = '—';
    ui.runningCount.textContent = '—';
    ui.attentionCount.textContent = '—';
    return;
  }
  ui.profileCount.textContent = String(profiles.length);
  ui.runningCount.textContent = String(tasks.filter((task) => ACTIVE_TASK_STATES.has(task.state || task.status)).length);
  ui.attentionCount.textContent = String(tasks.filter((task) => (
    ATTENTION_TASK_STATES.has(task.state || task.status) || task.health?.status === 'stalled'
  )).length);
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

async function refresh({ forceRender = false } = {}) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    if (!managerToken) {
      disconnectDashboard();
      return;
    }
    try {
      const [profilePayload, taskPayload] = await Promise.all([
        request('/v1/profiles'),
        request('/v1/tasks')
      ]);
      profiles = unpackList(profilePayload, 'profiles');
      tasks = unpackList(taskPayload, 'tasks');
      setConnected(true);
      renderProfiles(forceRender);
      renderTasks(forceRender);
      updateSummary();
      ui.lastRefresh.textContent = `刷新于 ${formatTime(new Date())}`;
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) setConnected(false);
      setMessage(error.message, 'error');
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function pollingDelay() {
  if (document.visibilityState === 'hidden') return 10_000;
  const live = tasks.some((task) => (
    ACTIVE_TASK_STATES.has(task.state || task.status) || POLLING_TASK_STATES.has(task.state || task.status)
  ));
  return live ? 1_000 : 5_000;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (pollingStopped) return;
  refreshTimer = setTimeout(async () => {
    await refresh();
    if (!pollingStopped) scheduleRefresh();
  }, pollingDelay());
}

async function createProfile(event) {
  event.preventDefault();
  const name = ui.profileName.value.trim();
  if (!name) return;
  try {
    await request('/v1/profiles', {
      method: 'POST',
      body: {
        name,
        kind: ui.profileKind.value,
        browserEngine: ui.profileEngine.value,
        defaultBehavior: ui.profileMode.value,
        headless: ui.profileHeadless.checked
      }
    });
    ui.profileName.value = '';
    ui.profileHeadless.checked = false;
    syncCreatePolicy();
    setMessage('Profile 已创建', 'success');
    await refresh({ forceRender: true });
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function updateProfile(id, patch) {
  try {
    await request(`/v1/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
    await refresh({ forceRender: true });
  } catch (error) {
    setMessage(error.message, 'error');
    await refresh({ forceRender: true });
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
    await refresh({ forceRender: true });
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function deleteProfile(profile) {
  const detail = profile.kind === 'ephemeral'
    ? '其临时任务设置将被清理。'
    : '其持久化浏览器数据将被清理。';
  if (!confirm(`删除 Profile “${profile.name}”？${detail}`)) return;
  try {
    await request(`/v1/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
    setMessage('Profile 已删除', 'success');
    await refresh({ forceRender: true });
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function cancelTask(task) {
  if (!confirm(`取消任务 “${task.taskType || task.id}”？`)) return;
  try {
    await request(`/v1/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST' });
    setMessage('取消请求已发送', 'success');
    await refresh({ forceRender: true });
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
    await refresh({ forceRender: true });
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

const initialCode = consumeCodeFromLocation();
managerToken = sessionStorage.getItem(TOKEN_KEY) || '';
ui.tokenForm.addEventListener('submit', saveToken);
ui.createProfileForm.addEventListener('submit', createProfile);
ui.profileKind.addEventListener('change', syncCreatePolicy);
ui.refreshAll.addEventListener('click', () => void refresh());
syncCreatePolicy();
void (async () => {
  const connectedFromCode = await connectFromDashboardCode(initialCode);
  if (!connectedFromCode) await refresh();
  scheduleRefresh();
})();
window.addEventListener('hashchange', () => {
  void connectFromDashboardCode(consumeCodeFromLocation());
});
document.addEventListener('visibilitychange', scheduleRefresh);
window.addEventListener('pagehide', () => {
  pollingStopped = true;
  clearTimeout(refreshTimer);
});
window.addEventListener('pageshow', () => {
  if (!pollingStopped) return;
  pollingStopped = false;
  scheduleRefresh();
});
