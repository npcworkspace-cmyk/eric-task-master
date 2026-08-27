const REQUEST_TIMEOUT_MS = 10_000;
const READ_RETRY_DELAY_MS = 300;
const VIEWS = new Set(['tasks', 'profiles']);
const ACTIVE_TASK_STATES = new Set([
  'queued', 'acquiring_profile', 'starting_browser', 'running', 'cooling_down',
  'recovering', 'verifying', 'pause_requested', 'cancel_requested', 'cancelling'
]);
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled', 'terminated']);
const PAUSABLE_TASK_STATES = new Set(['running', 'cooling_down', 'recovering', 'verifying']);
const TASK_STATE_LABELS = Object.freeze({
  queued: '排队中',
  acquiring_profile: '准备 Profile',
  starting_browser: '启动浏览器',
  running: '执行中',
  pause_requested: '正在暂停',
  paused: '已暂停',
  waiting_user: '等待处理',
  cooling_down: '限流冷却',
  recovering: '恢复中',
  verifying: '验收中',
  cancel_requested: '正在取消',
  cancelling: '正在取消',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  terminated: '已取消'
});
const ACTIVITY_LABELS = Object.freeze({
  queued: '等待调度',
  acquiring_profile: '准备 Profile',
  starting_browser: '启动浏览器',
  navigating: '正在打开页面',
  clicking: '正在点击',
  typing: '正在输入',
  hovering: '正在悬停',
  scrolling: '正在滚动页面',
  extracting: '正在提取内容',
  analyzing: '正在分析',
  working: '正在执行',
  running: '正在执行任务',
  waiting_user: '等待 Agent 处理',
  cooling_down: '正在等待限流恢复',
  recovering: '正在从检查点恢复',
  verifying: '正在验收结果',
  reporting: '正在收尾',
  cleaning_up: '正在关闭任务窗口',
  paused: '任务已暂停',
  completed: '任务已完成',
  failed: '任务失败',
  cancel_requested: '正在安全取消任务',
  cancelling: '正在安全取消任务',
  cancelled: '任务已取消'
});

const ui = Object.freeze({
  navLinks: [...document.querySelectorAll('[data-view]')],
  viewPanels: [...document.querySelectorAll('[data-view-panel]')],
  connectionDot: document.querySelector('#connection-dot'),
  connectionLabel: document.querySelector('#connection-label'),
  lastRefresh: document.querySelector('#last-refresh'),
  refreshAll: document.querySelector('#refresh-all'),
  logoutButton: document.querySelector('#logout-button'),
  authBanner: document.querySelector('#auth-banner'),
  retryAuth: document.querySelector('#retry-auth'),
  staleBanner: document.querySelector('#stale-banner'),
  retryStale: document.querySelector('#retry-stale'),
  taskCountChip: document.querySelector('#task-count-chip'),
  tasks: document.querySelector('#tasks'),
  tasksError: document.querySelector('#tasks-error'),
  profiles: document.querySelector('#profiles'),
  profilesError: document.querySelector('#profiles-error'),
  toggleProfileCreate: document.querySelector('#toggle-profile-create'),
  closeProfileCreate: document.querySelector('#close-profile-create'),
  profileCreatePanel: document.querySelector('#profile-create-panel'),
  createProfileForm: document.querySelector('#create-profile-form'),
  profileName: document.querySelector('#profile-name'),
  profileKind: document.querySelector('#profile-kind'),
  profileEngine: document.querySelector('#profile-engine'),
  profileMode: document.querySelector('#profile-mode'),
  profileHeadless: document.querySelector('#profile-headless'),
  message: document.querySelector('#dashboard-message')
});

const state = {
  authenticated: null,
  stale: false,
  visibleView: 'tasks',
  profiles: [],
  tasks: [],
  taskReceivedAt: new Map(),
  sectionErrors: {},
  mutationErrors: {},
  renderSignatures: new Map(),
  pendingMutations: new Set(),
  pendingFocusKey: '',
  focusIntentSequence: 0,
  refreshSequence: 0,
  refreshPromise: null,
  refreshAgain: false,
  refreshTimer: null,
  durationTimer: null,
  toastTimer: null,
  stopped: false,
  initialTaskId: new URL(location.href).searchParams.get('task') || '',
  initialTaskHandled: false
};

class HttpError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function element(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function button(label, className, action) {
  const node = element('button', `npc-btn ${className}`.trim(), label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dataFrom(payload) {
  if (payload?.ok === true && payload.data !== undefined) return payload.data;
  return payload?.data !== undefined ? payload.data : payload;
}

function listFrom(payload, key) {
  const data = dataFrom(payload);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

function errorMessage(payload, fallback) {
  return payload?.error?.message || payload?.message || payload?.error || fallback;
}

async function request(path, { method = 'GET', body } = {}) {
  const upperMethod = method.toUpperCase();
  const mayRetry = upperMethod === 'GET';
  const attempts = mayRetry ? 2 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(path, {
        method: upperMethod,
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
      if (response.ok) return payload;
      const error = new HttpError(
        errorMessage(payload, `请求失败 (${response.status})`),
        response.status,
        payload?.error?.code || payload?.code || ''
      );
      if (response.status === 401) markAuthorizationRequired();
      if (mayRetry && attempt === 0 && response.status >= 500) {
        lastError = error;
        await sleep(READ_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    } catch (error) {
      const normalized = error?.name === 'AbortError'
        ? new HttpError('本机 Manager 10 秒内没有响应', 0, 'REQUEST_TIMEOUT')
        : error instanceof HttpError
          ? error
          : new HttpError('无法连接本机 Manager', 0, 'NETWORK_ERROR');
      lastError = normalized;
      if (mayRetry && attempt === 0 && normalized.status === 0) {
        await sleep(READ_RETRY_DELAY_MS);
        continue;
      }
      throw normalized;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function bootstrapOwnerSession() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const code = hash.get('code') || '';
  if (!code) return;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(code)) return;
  try {
    await request('/v1/dashboard/session', { method: 'POST', body: { code } });
  } catch (error) {
    if (error.status !== 401) throw error;
  }
}

function markAuthorizationRequired() {
  state.authenticated = false;
  state.stale = false;
  state.refreshSequence += 1;
  state.profiles = [];
  state.tasks = [];
  state.taskReceivedAt.clear();
  state.sectionErrors = {};
  state.mutationErrors = {};
  state.pendingMutations.clear();
  state.renderSignatures.clear();
  state.pendingFocusKey = '';
  ui.authBanner.classList.remove('hidden');
  ui.staleBanner.classList.add('hidden');
  ui.logoutButton.classList.add('hidden');
  setConnectionState('unauthorized');
  renderAll(true);
}

function markConnected() {
  state.authenticated = true;
  state.stale = false;
  ui.authBanner.classList.add('hidden');
  ui.staleBanner.classList.add('hidden');
  ui.logoutButton.classList.remove('hidden');
  setConnectionState('connected');
}

function markStale() {
  if (state.authenticated === false) return;
  state.stale = true;
  ui.staleBanner.classList.remove('hidden');
  setConnectionState('stale');
}

function setConnectionState(mode) {
  const dotClasses = ['npc-signal-dot'];
  let label = '正在连接本机 Manager';
  if (mode === 'connected') {
    dotClasses.push('is-online');
    label = '本机 Manager 在线';
  } else if (mode === 'unauthorized') {
    dotClasses.push('is-offline');
    label = '需要建立 Owner 会话';
  } else if (mode === 'stale') {
    dotClasses.push('is-warning');
    label = '连接中断 · 自动重试';
  } else {
    dotClasses.push('is-pending');
  }
  ui.connectionDot.className = dotClasses.join(' ');
  ui.connectionLabel.textContent = label;
}

function setToast(message, kind = 'info') {
  clearTimeout(state.toastTimer);
  ui.message.textContent = message;
  ui.message.className = `toast ${kind}`;
  ui.message.classList.remove('hidden');
  state.toastTimer = setTimeout(() => ui.message.classList.add('hidden'), 6_000);
}

function setInlineError(node, message = '') {
  node.textContent = message;
  node.classList.toggle('hidden', !message);
}

function formatTime(value, { relative = false } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  if (relative) {
    const seconds = Math.round((date.valueOf() - Date.now()) / 1000);
    const absolute = Math.abs(seconds);
    if (absolute < 60) return seconds <= 0 ? '刚刚' : '即将';
    const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
    if (absolute < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
    if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
    return formatter.format(Math.round(seconds / 86400), 'day');
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(date);
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.floor(value / 1_000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  const clock = [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':');
  return days ? `${days}天 ${clock}` : clock;
}

function taskState(task) {
  return task?.state || task?.status || 'queued';
}

function taskStateLabel(task) {
  const value = taskState(task);
  return TASK_STATE_LABELS[value] || value;
}

function taskTitle(task) {
  return task?.displayName || task?.name || task?.taskLabel || task?.title || task?.taskType || task?.id || '未命名任务';
}

function taskActivity(task) {
  const phase = task?.currentActivity?.phase || task?.activity?.phase || taskState(task);
  const label = task?.currentActivity?.label || ACTIVITY_LABELS[phase] || ACTIVITY_LABELS[taskState(task)] || '等待反馈';
  const message = task?.progress?.message || task?.currentActivity?.message || task?.message || label;
  return { label, message, updatedAt: task?.progress?.updatedAt || task?.currentActivity?.updatedAt || task?.updatedAt };
}

function taskProgress(task) {
  const current = Number(task?.progress?.current ?? task?.progress?.completed);
  const total = Number(task?.progress?.total);
  const explicit = Number(task?.progress?.percent);
  const percent = Number.isFinite(explicit)
    ? Math.max(0, Math.min(100, explicit))
    : Number.isFinite(current) && Number.isFinite(total) && total > 0
      ? Math.max(0, Math.min(100, Math.round((current / total) * 100)))
      : TERMINAL_TASK_STATES.has(taskState(task)) && taskState(task) === 'completed'
        ? 100
        : null;
  const amount = Number.isFinite(current) && Number.isFinite(total) && total > 0 ? `${current}/${total}` : '';
  return { percent, amount };
}

function finiteDuration(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function elapsedBetween(start, end) {
  const startMs = Date.parse(start || '');
  const endMs = typeof end === 'number' ? end : Date.parse(end || '');
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
}

function taskDurations(task, at = Date.now()) {
  const timing = task?.timing && typeof task.timing === 'object' ? task.timing : {};
  const terminal = TERMINAL_TASK_STATES.has(taskState(task));
  const receivedAt = state.taskReceivedAt.get(task.id) || at;
  const liveDelta = terminal ? 0 : Math.max(0, at - receivedAt);
  const endAt = terminal && task.finishedAt ? Date.parse(task.finishedAt) : at;

  let total = finiteDuration(timing.totalDurationMs, timing.totalMs, timing.elapsedMs);
  if (total !== null) total += liveDelta;
  else total = elapsedBetween(task.createdAt, endAt);

  let run = finiteDuration(timing.runDurationMs, timing.runMs, timing.runningMs, timing.activeMs);
  if (run !== null) {
    const isActiveTime = timing.runDurationMs !== undefined || (
      timing.runMs === undefined && timing.runningMs === undefined && timing.activeMs !== undefined
    );
    const shouldTick = isActiveTime
      ? ACTIVE_TASK_STATES.has(taskState(task)) && taskState(task) !== 'cooling_down'
      : Boolean(task.startedAt) && !terminal;
    if (shouldTick) run += liveDelta;
  } else if (timing.recorded === false) {
    run = null;
  } else {
    run = task.startedAt ? elapsedBetween(task.startedAt, endAt) : 0;
  }

  let cooldown = finiteDuration(timing.cooldownDurationMs, timing.cooldownMs, timing.coolingDownMs);
  if (cooldown !== null && taskState(task) === 'cooling_down') cooldown += liveDelta;
  if (cooldown === null && timing.recorded === false) {
    cooldown = null;
  } else if (cooldown === null) {
    const activeCooldownStart = task?.cooldown?.startedAt || (taskState(task) === 'cooling_down' ? task?.updatedAt : null);
    cooldown = activeCooldownStart ? elapsedBetween(activeCooldownStart, endAt) : 0;
  }
  return { run, cooldown, total };
}

function profileState(profile) {
  return profile?.runtime?.state || profile?.state || (profile?.leased ? 'leased' : 'idle');
}

function profileMode(profile) {
  const mode = profile?.defaultBehavior || profile?.behaviorMode;
  if (mode === 'adaptive') return 'auto';
  return mode || (profile?.kind === 'persistent' ? 'human' : 'auto');
}

function taskBehaviorValue(task) {
  const configured = ['fast', 'auto', 'human'].includes(task?.behaviorState?.configured)
    ? task.behaviorState.configured
    : ['fast', 'auto', 'human'].includes(task?.behavior)
      ? task.behavior
      : null;
  const effective = ['fast', 'cautious', 'human'].includes(task?.behaviorState?.effective)
    ? task.behaviorState.effective
    : configured === 'auto' ? 'fast' : configured;
  const configuredLabel = ({ fast: '快速', auto: '自动', human: '深度拟人' })[configured] || '待分配';
  const effectiveLabel = ({ fast: '快速节奏', cautious: '谨慎节奏', human: '深度拟人节奏' })[effective] || '待应用';
  const confirmed = task?.behaviorState?.source === 'worker' && task?.behaviorState?.confirmed === true;
  return {
    configured,
    effective,
    confirmed,
    label: configured === 'auto' ? `${configuredLabel} · ${effectiveLabel}` : configuredLabel,
    receipt: confirmed
      ? `Worker 已确认 · ${formatTime(task.behaviorState.at, { relative: true })}`
      : '等待 Worker 应用'
  };
}

function profileEngine(profile) {
  return profile?.browserEngine === 'chromium' ? 'Chromium' : 'Chrome';
}

function containsInteractiveFocus(container) {
  const active = document.activeElement;
  return Boolean(active && container.contains(active) && active.matches('input, select, textarea, button'));
}

function focusKey(node, value) {
  node.dataset.focusKey = value;
  return node;
}

function restoreFocus(value) {
  if (!value) return false;
  const target = document.querySelector(`[data-focus-key="${CSS.escape(value)}"]`) || document.querySelector(`#${CSS.escape(value)}`);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

function renderWhenChanged(key, value, container, renderer, force = false) {
  const signature = JSON.stringify(value);
  if (!force && state.renderSignatures.get(key) === signature) return;
  if (!force && containsInteractiveFocus(container)) return;
  state.renderSignatures.set(key, signature);
  renderer();
}

function setView(requested, { updateHistory = true, focus = true } = {}) {
  const view = VIEWS.has(requested) ? requested : 'tasks';
  state.visibleView = view;
  for (const link of ui.navLinks) {
    const active = link.dataset.view === view;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const panel of ui.viewPanels) {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  }
  if (updateHistory) {
    const url = new URL(location.href);
    if (view === 'tasks') url.searchParams.delete('view');
    else url.searchParams.set('view', view);
    history.pushState(null, '', `${url.pathname}${url.search}`);
  }
  if (focus) document.querySelector(`#${view}-title`)?.focus();
}

function labelledValue(label, value, className = '') {
  const group = element('span', `labelled-value ${className}`.trim());
  group.append(element('small', '', label), element('strong', '', value));
  return group;
}

function durationValue(task, kind, label) {
  const group = labelledValue(label, '—', 'duration-value');
  const value = group.querySelector('strong');
  value.dataset.taskDuration = kind;
  value.dataset.taskId = task.id;
  value.textContent = formatDuration(taskDurations(task)[kind]);
  return group;
}

function behaviorValue(task) {
  const behavior = taskBehaviorValue(task);
  const group = labelledValue('实际行为', behavior.label, 'behavior-value');
  group.dataset.taskBehavior = behavior.configured || '';
  group.dataset.taskBehaviorEffective = behavior.effective || '';
  group.dataset.taskBehaviorConfirmed = String(behavior.confirmed);
  group.append(element('small', 'behavior-receipt', behavior.receipt));
  return group;
}

function profileNameFor(task) {
  return task.profileName || state.profiles.find((profile) => profile.id === task.profileId)?.name || task.profileId || '—';
}

function commandId() {
  return `dashboard:${crypto.randomUUID()}`;
}

function taskActionButtons(task) {
  const actions = element('div', 'task-actions');
  const status = taskState(task);
  const key = `task:${task.id}`;
  const pending = state.pendingMutations.has(key);
  if (PAUSABLE_TASK_STATES.has(status)) {
    const pause = focusKey(button('暂停', 'npc-btn-secondary compact-button', () => void sendTaskAction(task, 'pause')), `${key}:pause`);
    pause.disabled = pending;
    actions.append(pause);
  }
  if (status === 'paused') {
    const resume = focusKey(button('恢复', 'npc-btn-primary compact-button', () => void sendTaskAction(task, 'resume')), `${key}:resume`);
    resume.disabled = pending;
    actions.append(resume);
  }
  if (!TERMINAL_TASK_STATES.has(status)) {
    const cancel = focusKey(button('取消', 'npc-btn-danger compact-button', () => void sendTaskAction(task, 'cancel')), `${key}:cancel`);
    cancel.disabled = pending || ['cancel_requested', 'cancelling'].includes(status);
    actions.append(cancel);
  } else {
    const remove = focusKey(button('删除记录', 'npc-btn-danger compact-button', () => void deleteTaskRecord(task)), `${key}:delete`);
    const settled = task.cleanup?.settled === true;
    remove.disabled = pending || !settled;
    if (!settled) remove.title = '任务清理完成后才能删除记录';
    actions.append(remove);
  }
  return actions;
}

function renderTasks(force = false) {
  const ordered = [...state.tasks].sort((left, right) => {
    const leftTerminal = TERMINAL_TASK_STATES.has(taskState(left));
    const rightTerminal = TERMINAL_TASK_STATES.has(taskState(right));
    if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
    return Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0);
  });
  renderWhenChanged('tasks', { ordered, pending: [...state.pendingMutations].filter((key) => key.startsWith('task:')) }, ui.tasks, () => {
    ui.tasks.replaceChildren();
    if (!ordered.length) {
      ui.tasks.append(element('p', 'empty-state', state.authenticated === false ? '建立 Owner 会话后即可查看任务。' : '当前还没有任务。'));
      return;
    }
    for (const task of ordered) {
      const status = taskState(task);
      const progress = taskProgress(task);
      const activity = taskActivity(task);
      const card = focusKey(element('article', `task-card task-${status}`), `task:${task.id}:card`);
      card.tabIndex = -1;
      card.dataset.taskId = task.id;
      if (state.initialTaskId === task.id && !state.initialTaskHandled) card.classList.add('is-targeted');

      const heading = element('div', 'task-card-heading');
      const headingCopy = element('div');
      headingCopy.append(element('h2', '', taskTitle(task)), element('p', 'task-activity', activity.label));
      heading.append(headingCopy, element('span', `npc-chip task-state-chip task-state-${status}`, taskStateLabel(task)));

      const progressBlock = element('div', 'task-progress-block');
      const progressCopy = element('div', 'progress-copy');
      progressCopy.append(element('strong', '', activity.message), element('span', 'npc-number', progress.amount || (progress.percent === null ? '进行中' : `${progress.percent}%`)));
      const track = element('div', 'progress-track');
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', `${taskTitle(task)}进度`);
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      if (progress.percent === null) track.setAttribute('aria-valuetext', '正在执行，尚无总量');
      else track.setAttribute('aria-valuenow', String(progress.percent));
      const bar = element('span', 'progress-bar');
      bar.style.width = `${progress.percent ?? (TERMINAL_TASK_STATES.has(status) ? 100 : 4)}%`;
      track.append(bar);
      progressBlock.append(progressCopy, track);

      const metadata = element('div', 'task-meta-row');
      metadata.append(
        labelledValue('Profile', profileNameFor(task)),
        behaviorValue(task),
        durationValue(task, 'run', '运行时间'),
        durationValue(task, 'cooldown', '冷却时间'),
        durationValue(task, 'total', '总时间')
      );

      const footer = element('div', 'task-card-footer');
      footer.append(
        element('span', 'task-updated', `最近反馈 ${formatTime(activity.updatedAt, { relative: true })}`),
        taskActionButtons(task)
      );
      card.append(heading, progressBlock, metadata, footer);
      ui.tasks.append(card);
    }
  }, force);
  const active = state.tasks.filter((task) => !TERMINAL_TASK_STATES.has(taskState(task))).length;
  ui.taskCountChip.textContent = `${active} 个进行中 · ${state.tasks.length} 个任务`;
  setInlineError(ui.tasksError, state.mutationErrors.tasks || state.sectionErrors.tasks || '');
}

function renderProfiles(force = false) {
  renderWhenChanged('profiles', { profiles: state.profiles, pending: [...state.pendingMutations].filter((key) => key.startsWith('profile:')) }, ui.profiles, () => {
    ui.profiles.replaceChildren();
    if (!state.profiles.length) {
      ui.profiles.append(element('p', 'empty-state span-all', state.authenticated === false ? '建立 Owner 会话后即可查看 Profiles。' : '还没有 Profile。创建一个浏览器环境开始任务。'));
      return;
    }
    for (const profile of state.profiles) {
      const id = profile.id;
      const currentState = profileState(profile);
      const persistent = profile.kind !== 'ephemeral';
      const busy = !['idle', 'closed'].includes(currentState);
      const quarantinedEphemeral = !persistent && currentState === 'error' && profile.cleanupRequired === true;
      const pending = state.pendingMutations.has(`profile:${id}`);
      const card = element('article', `profile-card profile-${profile.kind || 'persistent'}`);
      const heading = element('div', 'card-heading');
      const title = element('div');
      title.append(element('p', 'npc-eyebrow', persistent ? 'PERSISTENT' : 'EPHEMERAL'), element('h2', '', profile.name || id));
      const stateLabel = ({ idle: '空闲', closed: '已关闭', open: '人工打开', leased: '任务占用', starting: '启动中', error: '需检查' })[currentState] || currentState;
      heading.append(title, element('span', `npc-chip profile-state-${currentState}`, stateLabel));

      const facts = element('div', 'profile-facts');
      facts.append(
        labelledValue('浏览器', profileEngine(profile)),
        labelledValue('操作速度', ({ human: '深度拟人', auto: '自动平衡', fast: '快速' })[profileMode(profile)] || profileMode(profile)),
        labelledValue('最近使用', formatTime(profile.lastUsedAt, { relative: true }))
      );

      const settings = element('div', 'profile-settings');
      const modeLabel = element('label');
      modeLabel.append(element('span', '', '操作速度'));
      const mode = focusKey(element('select', 'npc-field compact-field'), `profile:${id}:mode`);
      for (const value of ['fast', 'auto', 'human']) {
        const option = element('option', '', ({ fast: '快速', auto: '自动平衡', human: '深度拟人' })[value]);
        option.value = value;
        mode.append(option);
      }
      mode.value = profileMode(profile);
      mode.disabled = pending;
      mode.title = busy
        ? '运行中切换会立即应用到当前任务，无需重启'
        : '为这个 Profile 选择快速、自动平衡或深度拟人';
      mode.addEventListener('change', () => void updateProfile(profile, { defaultBehavior: mode.value }));
      modeLabel.append(mode);
      const headlessLabel = element('label', 'switch-field');
      const headless = focusKey(element('input'), `profile:${id}:headless`);
      headless.type = 'checkbox';
      headless.checked = Boolean(profile.headless);
      headless.disabled = pending;
      headless.addEventListener('change', () => void updateProfile(profile, { headless: headless.checked }));
      headlessLabel.append(headless, element('span', '', '任务后台运行'));
      settings.append(modeLabel, headlessLabel);

      const actions = element('div', 'profile-actions');
      const rename = focusKey(button('改名', 'npc-btn-ghost compact-button', () => void renameProfile(profile)), `profile:${id}:rename`);
      const toggleLabel = persistent ? (busy ? '关闭窗口' : '打开登录窗口') : '仅任务启动';
      const toggle = focusKey(button(toggleLabel, 'npc-btn-secondary compact-button', () => void setProfileOpen(profile, !busy)), `profile:${id}:toggle`);
      toggle.disabled = !persistent || pending || currentState === 'starting';
      toggle.title = persistent ? '打开独立可见 Chrome 窗口进行人工登录或检查' : '临时 Profile 只在任务中启动';
      const remove = focusKey(button(quarantinedEphemeral ? '清理残留' : '删除', 'npc-btn-danger compact-button', () => void deleteProfile(profile)), `profile:${id}:delete`);
      rename.disabled = pending;
      remove.disabled = (busy && !quarantinedEphemeral) || pending;
      remove.title = quarantinedEphemeral
        ? '任务清理未确认；Manager 会再次确认 Worker 已退出且临时目录为空后再清理'
        : busy
          ? 'Profile 空闲后才能删除'
          : '删除这个 Profile';
      actions.append(rename, toggle, remove);
      card.append(heading, facts, settings, actions);
      ui.profiles.append(card);
    }
  }, force);
  setInlineError(ui.profilesError, state.mutationErrors.profiles || state.sectionErrors.profiles || '');
}

function renderAll(force = false) {
  const activeFocusKey = document.activeElement?.dataset?.focusKey || state.pendingFocusKey || '';
  renderTasks(force);
  renderProfiles(force);
  if (activeFocusKey && restoreFocus(activeFocusKey)) state.pendingFocusKey = '';
  focusInitialTask();
}

function applyRefreshResult(key, result, receivedAt) {
  if (result.status === 'fulfilled') {
    state.sectionErrors[key] = '';
    if (key === 'profiles') state.profiles = listFrom(result.value, 'profiles');
    if (key === 'tasks') {
      state.tasks = listFrom(result.value, 'tasks');
      state.taskReceivedAt = new Map(state.tasks.map((task) => [task.id, receivedAt]));
    }
    return true;
  }
  const error = result.reason;
  if (error?.status !== 401) state.sectionErrors[key] = error?.message || '读取失败';
  return false;
}

async function refreshAll({ force = false } = {}) {
  if (state.refreshPromise) {
    state.refreshAgain = true;
    return state.refreshPromise;
  }
  const sequence = ++state.refreshSequence;
  ui.refreshAll.disabled = true;
  ui.refreshAll.classList.add('is-loading');
  state.refreshPromise = (async () => {
    const results = await Promise.allSettled([
      request('/v1/profiles'),
      request('/v1/tasks')
    ]);
    if (sequence !== state.refreshSequence) return;
    const receivedAt = Date.now();
    const keys = ['profiles', 'tasks'];
    const successCount = results.reduce((count, result, index) => count + Number(applyRefreshResult(keys[index], result, receivedAt)), 0);
    const unauthorized = results.some((result) => result.status === 'rejected' && result.reason?.status === 401);
    const connectivityFailure = results.every((result) => result.status === 'rejected' && (result.reason?.status === 0 || result.reason?.status >= 500));
    if (unauthorized) markAuthorizationRequired();
    else if (successCount > 0) markConnected();
    else if (connectivityFailure) markStale();
    if (successCount > 0) ui.lastRefresh.textContent = `刷新于 ${formatTime(receivedAt)}`;
    renderAll(force);
  })();
  try {
    await state.refreshPromise;
  } finally {
    state.refreshPromise = null;
    ui.refreshAll.disabled = false;
    ui.refreshAll.classList.remove('is-loading');
    if (state.refreshAgain) {
      state.refreshAgain = false;
      void refreshAll({ force: true });
    }
  }
}

function pollingDelay() {
  if (document.visibilityState === 'hidden') return 15_000;
  return state.tasks.some((task) => !TERMINAL_TASK_STATES.has(taskState(task))) ? 2_000 : 6_000;
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  if (state.stopped) return;
  state.refreshTimer = setTimeout(async () => {
    await refreshAll();
    scheduleRefresh();
  }, pollingDelay());
}

function updateDurationDisplays() {
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const at = Date.now();
  for (const node of document.querySelectorAll('[data-task-duration]')) {
    const task = byId.get(node.dataset.taskId);
    const kind = node.dataset.taskDuration;
    if (task && ['run', 'cooldown', 'total'].includes(kind)) node.textContent = formatDuration(taskDurations(task, at)[kind]);
  }
}

function scheduleDurationTick() {
  clearTimeout(state.durationTimer);
  if (state.stopped) return;
  state.durationTimer = setTimeout(() => {
    updateDurationDisplays();
    scheduleDurationTick();
  }, document.visibilityState === 'hidden' ? 5_000 : 1_000);
}

function focusInitialTask() {
  if (state.initialTaskHandled || !state.initialTaskId || state.authenticated !== true || state.sectionErrors.tasks) return;
  const card = ui.tasks.querySelector(`.task-card[data-task-id="${CSS.escape(state.initialTaskId)}"]`);
  state.initialTaskHandled = true;
  if (card) {
    setView('tasks', { updateHistory: false, focus: false });
    card.classList.add('is-targeted');
    card.focus();
    card.scrollIntoView({ block: 'center' });
  } else {
    setToast('指定的任务记录不存在或已删除', 'error');
    const url = new URL(location.href);
    url.searchParams.delete('task');
    history.replaceState(null, '', `${url.pathname}${url.search}`);
  }
}

function profileCreateVisible(visible) {
  ui.profileCreatePanel.classList.toggle('hidden', !visible);
  ui.toggleProfileCreate.setAttribute('aria-expanded', String(visible));
  if (visible) ui.profileName.focus();
  else ui.toggleProfileCreate.focus();
}

function syncCreatePolicy() {
  const persistent = ui.profileKind.value === 'persistent';
  ui.profileEngine.value = persistent ? 'chrome' : 'chromium';
  ui.profileMode.value = persistent ? 'human' : 'auto';
  ui.profileEngine.disabled = persistent;
  ui.profileMode.disabled = false;
  ui.profileEngine.title = persistent ? '持久 Profile 固定使用本机稳定版 Chrome' : '临时 Profile 使用项目锁定 Chromium';
  ui.profileMode.title = persistent ? '默认深度拟人，可创建后随时切换' : '默认自动平衡，可创建后随时切换';
}

function mutationSection(key) {
  if (key.startsWith('profile:')) return 'profiles';
  if (key.startsWith('task:')) return 'tasks';
  return '';
}

async function runMutation(key, operation, successMessage, { focusAfter = '' } = {}) {
  if (state.pendingMutations.has(key)) return null;
  const activeFocusKey = document.activeElement?.dataset?.focusKey || '';
  const focusIntentSequence = ++state.focusIntentSequence;
  state.pendingFocusKey = activeFocusKey;
  state.pendingMutations.add(key);
  renderAll(true);
  try {
    const result = await operation();
    const section = mutationSection(key);
    if (section) state.mutationErrors[section] = '';
    if (successMessage) setToast(successMessage, 'success');
    return result;
  } catch (error) {
    const section = mutationSection(key);
    let message = error.message || '操作失败';
    if (error.status === 403) message = `没有权限执行这项操作：${message}`;
    if (error.status === 409) {
      message = error.code === 'PROFILE_NAME_EXISTS'
        ? 'Profile 名称已存在，请换一个名称。'
        : error.code === 'TASK_REVISION_CONFLICT'
          ? '状态已变化，已刷新最新状态。请确认后重试。'
          : `${message} 已刷新最新状态。`;
    }
    if (error.status !== 401) {
      if (section) state.mutationErrors[section] = message;
      setToast(message, 'error');
    }
    return null;
  } finally {
    state.pendingMutations.delete(key);
    await refreshAll({ force: true });
    if (focusIntentSequence === state.focusIntentSequence) {
      const target = focusAfter || activeFocusKey;
      if (target && restoreFocus(target)) state.pendingFocusKey = '';
      else if (focusAfter) document.querySelector('#tasks-title')?.focus();
    }
  }
}

async function createProfile(event) {
  event.preventDefault();
  const name = ui.profileName.value.trim();
  if (!name) return;
  const result = await runMutation('profile:create', () => request('/v1/profiles', {
    method: 'POST',
    body: {
      name,
      kind: ui.profileKind.value,
      browserEngine: ui.profileEngine.value,
      defaultBehavior: ui.profileMode.value,
      headless: ui.profileHeadless.checked
    }
  }), 'Profile 已创建');
  if (result) {
    ui.createProfileForm.reset();
    syncCreatePolicy();
    profileCreateVisible(false);
  }
}

async function updateProfile(profile, patch) {
  await runMutation(`profile:${profile.id}`, () => request(`/v1/profiles/${encodeURIComponent(profile.id)}`, {
    method: 'PATCH', body: patch
  }), Object.hasOwn(patch, 'defaultBehavior')
    ? '操作速度已生效，运行中的任务无需重启'
    : 'Profile 设置已保存');
}

async function renameProfile(profile) {
  const value = prompt('新的 Profile 名称', profile.name || '')?.trim();
  if (value && value !== profile.name) await updateProfile(profile, { name: value });
}

async function setProfileOpen(profile, shouldOpen) {
  const action = shouldOpen ? 'open' : 'close';
  await runMutation(`profile:${profile.id}`, () => request(`/v1/profiles/${encodeURIComponent(profile.id)}/${action}`, {
    method: 'POST'
  }), shouldOpen ? '正在打开独立登录窗口' : 'Profile 窗口已关闭');
}

async function deleteProfile(profile) {
  const quarantinedEphemeral = profile.kind === 'ephemeral' && profileState(profile) === 'error' && profile.cleanupRequired === true;
  const description = profile.kind === 'ephemeral' ? '临时任务设置' : '持久浏览器数据';
  const question = quarantinedEphemeral
    ? `确定清理异常临时 Profile“${profile.name || profile.id}”？Manager 只会在 Worker 已退出且目录为空时执行。`
    : `确定删除 Profile“${profile.name || profile.id}”及其${description}？此操作无法撤销。`;
  if (!confirm(question)) return;
  await runMutation(`profile:${profile.id}`, () => request(`/v1/profiles/${encodeURIComponent(profile.id)}`, {
    method: 'DELETE'
  }), quarantinedEphemeral ? '残留临时 Profile 已清理' : 'Profile 已删除', { focusAfter: 'profiles-title' });
}

async function sendTaskAction(task, action) {
  if (state.pendingMutations.has(`task:${task.id}`)) return;
  if (action === 'cancel' && !confirm(`确定取消任务“${taskTitle(task)}”？Manager 会先关闭任务窗口并释放 Profile。`)) return;
  if (!Number.isSafeInteger(task.revision) || task.revision < 1) {
    setToast('任务版本尚未就绪，正在刷新最新状态', 'error');
    await refreshAll({ force: true });
    return;
  }
  const labels = { pause: '暂停请求已发送', resume: '恢复请求已发送', cancel: '取消请求已发送' };
  await runMutation(`task:${task.id}`, () => request(`/v1/tasks/${encodeURIComponent(task.id)}/actions`, {
    method: 'POST',
    body: { action, commandId: commandId(), expectedRevision: task.revision }
  }), labels[action]);
}

async function deleteTaskRecord(task) {
  if (state.pendingMutations.has(`task:${task.id}`)) return;
  if (!confirm(`确定删除任务记录“${taskTitle(task)}”？它会从面板消失且无法恢复，已生成的数据文件不会被删除。`)) return;
  if (!Number.isSafeInteger(task.revision) || task.revision < 1) {
    setToast('任务版本尚未就绪，正在刷新最新状态', 'error');
    await refreshAll({ force: true });
    return;
  }
  const orderedIds = [...ui.tasks.querySelectorAll('.task-card[data-task-id]')].map((node) => node.dataset.taskId);
  const index = orderedIds.indexOf(task.id);
  const nextId = orderedIds[index + 1] || orderedIds[index - 1] || '';
  const focusAfter = nextId ? `task:${nextId}:card` : 'tasks-title';
  await runMutation(`task:${task.id}`, () => request(`/v1/tasks/${encodeURIComponent(task.id)}`, {
    method: 'DELETE',
    body: { commandId: commandId(), expectedRevision: task.revision }
  }), '任务记录已删除', { focusAfter });
}

async function logout() {
  if (!confirm('退出这台浏览器的 Owner 会话？后台任务不会停止。')) return;
  try {
    await request('/v1/dashboard/logout', { method: 'POST' });
    markAuthorizationRequired();
    setToast('已退出；后台任务仍在继续', 'success');
  } catch (error) {
    if (error.status !== 401) setToast(error.message || '退出失败', 'error');
  }
}

for (const link of ui.navLinks) link.addEventListener('click', () => setView(link.dataset.view));
ui.refreshAll.addEventListener('click', () => void refreshAll({ force: true }));
ui.retryAuth.addEventListener('click', () => void refreshAll({ force: true }));
ui.retryStale.addEventListener('click', () => void refreshAll({ force: true }));
ui.logoutButton.addEventListener('click', () => void logout());
ui.toggleProfileCreate.addEventListener('click', () => profileCreateVisible(true));
ui.closeProfileCreate.addEventListener('click', () => profileCreateVisible(false));
ui.profileKind.addEventListener('change', syncCreatePolicy);
ui.createProfileForm.addEventListener('submit', createProfile);
document.addEventListener('visibilitychange', () => {
  scheduleRefresh();
  scheduleDurationTick();
});
window.addEventListener('popstate', () => {
  const url = new URL(location.href);
  setView(url.searchParams.get('view') || 'tasks', { updateHistory: false, focus: false });
});
window.addEventListener('pagehide', () => {
  state.stopped = true;
  clearTimeout(state.refreshTimer);
  clearTimeout(state.durationTimer);
});
window.addEventListener('pageshow', () => {
  if (!state.stopped) return;
  state.stopped = false;
  void refreshAll({ force: true });
  scheduleRefresh();
  scheduleDurationTick();
});

const initialUrl = new URL(location.href);
setView(initialUrl.searchParams.get('view') || 'tasks', { updateHistory: false, focus: false });
syncCreatePolicy();
void bootstrapOwnerSession()
  .catch((error) => {
    if (error.status !== 401) setToast(error.message || '无法建立 Owner 会话', 'error');
  })
  .then(() => refreshAll({ force: true }))
  .finally(() => {
    scheduleRefresh();
    scheduleDurationTick();
  });
