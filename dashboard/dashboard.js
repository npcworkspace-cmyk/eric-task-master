const READ_REQUEST_TIMEOUT_MS = 10_000;
const MUTATION_REQUEST_TIMEOUT_MS = 60_000;
const READ_RETRY_DELAY_MS = 300;
const LANGUAGE_STORAGE_KEY = 'eric-task-master-language';
const VIEWS = new Set(['tasks', 'profiles']);
const TERMINAL_STATES = new Set(['finished', 'stopped', 'error']);

const I18N = Object.freeze({
  'zh-CN': Object.freeze({
    'page.title': 'Eric Task Master · 本机任务面板',
    'skip.main': '跳到主要内容',
    'brand.home': 'Eric Task Master 任务面板首页',
    'nav.primary': '主要导航',
    'nav.tasks': '任务',
    'nav.profiles': 'Profiles',
    'common.loading': '读取中',
    'common.close': '关闭',
    'common.delete': '删除',
    'connection.connecting': '正在连接本机 Manager',
    'connection.online': '本机 Manager 在线',
    'connection.offline': 'Manager 暂时离线',
    'connection.never': '尚未刷新',
    'connection.refreshed': '刷新于 {time}',
    'refresh.aria': '刷新任务和 Profiles',
    'refresh.title': '刷新任务和 Profiles',
    'offline.title': '暂时无法连接 Manager',
    'offline.body': '面板会保留上次状态并自动重试，后台任务不受影响。',
    'offline.retry': '立即重试',
    'tasks.title': '任务进度',
    'tasks.description': '实时查看处理数量与当前动作；需要时可停止、恢复或删除任务。',
    'tasks.loading': '正在读取任务…',
    'tasks.empty': '当前还没有任务。Agent 启动任务后会立即显示在这里。',
    'tasks.count': '{active} 个运行中 · 共 {total} 个',
    'tasks.untitled': '未命名任务',
    'tasks.processed': '已处理 {current}',
    'tasks.inProgress': '正在执行',
    'tasks.progressAria': '{title}进度',
    'tasks.progressUnknown': '正在执行，尚无总量',
    'tasks.profile': 'Profile',
    'tasks.elapsed': '运行时间',
    'tasks.updated': '最近进度',
    'tasks.stop': '停止',
    'tasks.resume': '恢复',
    'tasks.delete': '删除',
    'tasks.targetMissing': '指定的任务不存在或已经删除',
    'state.running': '运行中',
    'state.waiting': '等待中',
    'state.finished': '已结束',
    'state.stopped': '已停止',
    'state.error': '发生错误',
    'activity.running': '正在执行任务',
    'activity.waiting': '任务正在等待',
    'activity.finished': '任务已结束',
    'activity.stopped': '任务已停止',
    'activity.error': '任务遇到错误',
    'profiles.title': '浏览器 Profiles',
    'profiles.description': '管理独立 Chrome 环境，并指定未声明任务使用的默认 Profile。',
    'profiles.new': '新建 Profile',
    'profiles.createTitle': '创建浏览器环境',
    'profiles.name': 'Profile 名称',
    'profiles.namePlaceholder': '例如：工作账号',
    'profiles.create': '创建 Profile',
    'profiles.formNote': 'Profile 使用本机 Chrome，并长期保留登录状态。第一个 Profile 会自动成为默认项。',
    'profiles.loading': '正在读取 Profiles…',
    'profiles.empty': '还没有 Profile。创建一个浏览器环境后即可登录并运行任务。',
    'profiles.default': '默认',
    'profiles.setDefault': '设为默认',
    'profiles.chrome': '本机 Chrome',
    'profiles.browser': '浏览器',
    'profiles.recent': '最近使用',
    'profiles.open': '打开',
    'profiles.close': '关闭',
    'profiles.inUse': '任务使用中',
    'profileState.closed': '已关闭',
    'profileState.open': '已打开',
    'profileState.inUse': '任务使用中',
    'profileState.error': '需检查',
    'error.request': '请求失败 ({status})',
    'error.timeout': '本机 Manager 未在规定时间内响应',
    'error.network': '无法连接本机 Manager',
    'error.read': '读取失败',
    'error.operation': '操作失败',
    'error.nameExists': 'Profile 名称已存在，请换一个名称。',
    'toast.taskStopped': '任务已停止',
    'toast.taskResumed': '任务已恢复',
    'toast.taskDeleted': '任务已删除',
    'toast.profileCreated': 'Profile 已创建',
    'toast.profileDefault': '默认 Profile 已更新',
    'toast.profileOpened': 'Profile 已打开',
    'toast.profileClosed': 'Profile 已关闭',
    'toast.profileDeleted': 'Profile 已删除',
    'confirm.deleteTask': '确定删除任务“{title}”？\n\n这会永久删除该任务记录和 Manager 内的全部产物；请先复制需要的文件。如果任务仍在运行，Manager 会同步停止它。',
    'confirm.deleteProfile': '确定删除 Profile“{name}”？\n\n这会停止正在使用它的任务、关闭 Chrome，并永久删除其中的登录状态。'
  }),
  en: Object.freeze({
    'page.title': 'Eric Task Master · Local Task Panel',
    'skip.main': 'Skip to main content',
    'brand.home': 'Eric Task Master task panel home',
    'nav.primary': 'Primary navigation',
    'nav.tasks': 'Tasks',
    'nav.profiles': 'Profiles',
    'common.loading': 'Loading',
    'common.close': 'Close',
    'common.delete': 'Delete',
    'connection.connecting': 'Connecting to local Manager',
    'connection.online': 'Local Manager online',
    'connection.offline': 'Manager temporarily offline',
    'connection.never': 'Not refreshed yet',
    'connection.refreshed': 'Refreshed at {time}',
    'refresh.aria': 'Refresh tasks and Profiles',
    'refresh.title': 'Refresh tasks and Profiles',
    'offline.title': 'Manager is temporarily unavailable',
    'offline.body': 'The panel keeps the last known state and retries automatically. Background tasks are not interrupted.',
    'offline.retry': 'Retry now',
    'tasks.title': 'Task progress',
    'tasks.description': 'See processed counts and the current action in real time. Stop, resume, or delete a task when needed.',
    'tasks.loading': 'Loading tasks…',
    'tasks.empty': 'No tasks yet. A task appears here as soon as an Agent starts it.',
    'tasks.count': '{active} running · {total} total',
    'tasks.untitled': 'Untitled task',
    'tasks.processed': '{current} processed',
    'tasks.inProgress': 'In progress',
    'tasks.progressAria': 'Progress for {title}',
    'tasks.progressUnknown': 'Running without a declared total',
    'tasks.profile': 'Profile',
    'tasks.elapsed': 'Elapsed',
    'tasks.updated': 'Last progress',
    'tasks.stop': 'Stop',
    'tasks.resume': 'Resume',
    'tasks.delete': 'Delete',
    'tasks.targetMissing': 'The requested task does not exist or has been deleted',
    'state.running': 'Running',
    'state.waiting': 'Waiting',
    'state.finished': 'Finished',
    'state.stopped': 'Stopped',
    'state.error': 'Error',
    'activity.running': 'Running the task',
    'activity.waiting': 'The task is waiting',
    'activity.finished': 'The task has finished',
    'activity.stopped': 'The task has stopped',
    'activity.error': 'The task encountered an error',
    'profiles.title': 'Browser Profiles',
    'profiles.description': 'Manage isolated Chrome environments and choose the default for tasks that do not name one.',
    'profiles.new': 'New Profile',
    'profiles.createTitle': 'Create browser environment',
    'profiles.name': 'Profile name',
    'profiles.namePlaceholder': 'For example: Work account',
    'profiles.create': 'Create Profile',
    'profiles.formNote': 'Profiles use local Chrome and retain login state. The first Profile becomes the default automatically.',
    'profiles.loading': 'Loading Profiles…',
    'profiles.empty': 'No Profiles yet. Create one, sign in, and start a task.',
    'profiles.default': 'Default',
    'profiles.setDefault': 'Set default',
    'profiles.chrome': 'Local Chrome',
    'profiles.browser': 'Browser',
    'profiles.recent': 'Last used',
    'profiles.open': 'Open',
    'profiles.close': 'Close',
    'profiles.inUse': 'Task in progress',
    'profileState.closed': 'Closed',
    'profileState.open': 'Open',
    'profileState.inUse': 'Task in progress',
    'profileState.error': 'Needs attention',
    'error.request': 'Request failed ({status})',
    'error.timeout': 'The local Manager did not respond in time',
    'error.network': 'Cannot reach the local Manager',
    'error.read': 'Could not load data',
    'error.operation': 'Operation failed',
    'error.nameExists': 'That Profile name already exists. Choose another name.',
    'toast.taskStopped': 'Task stopped',
    'toast.taskResumed': 'Task resumed',
    'toast.taskDeleted': 'Task deleted',
    'toast.profileCreated': 'Profile created',
    'toast.profileDefault': 'Default Profile updated',
    'toast.profileOpened': 'Profile opened',
    'toast.profileClosed': 'Profile closed',
    'toast.profileDeleted': 'Profile deleted',
    'confirm.deleteTask': 'Delete “{title}”?\n\nThis permanently removes the task record and every artifact stored by Manager. Copy anything you need first. If the task is running, Manager stops it synchronously.',
    'confirm.deleteProfile': 'Delete Profile “{name}”?\n\nThis stops tasks using it, closes Chrome, and permanently removes its login state.'
  })
});

function initialLanguage() {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === 'en' || saved === 'zh-CN') return saved;
  } catch {}
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

const state = {
  language: initialLanguage(),
  visibleView: 'tasks',
  manager: null,
  connected: false,
  tasks: [],
  profiles: [],
  defaultProfileId: '',
  pending: new Set(),
  errors: { tasks: '', profiles: '' },
  refreshPromise: null,
  refreshAgain: false,
  refreshSequence: 0,
  refreshTimer: null,
  durationTimer: null,
  toastTimer: null,
  lastRefreshAt: 0,
  targetedTaskId: '',
  initialTaskFocused: false,
  initialTaskFocusPending: false,
  stopped: false
};

const ui = {
  navLinks: [...document.querySelectorAll('[data-view]')],
  viewPanels: [...document.querySelectorAll('[data-view-panel]')],
  connectionDot: document.querySelector('#connection-dot'),
  connectionLabel: document.querySelector('#connection-label'),
  lastRefresh: document.querySelector('#last-refresh'),
  languageToggle: document.querySelector('#language-toggle'),
  refreshAll: document.querySelector('#refresh-all'),
  offlineBanner: document.querySelector('#offline-banner'),
  retryOffline: document.querySelector('#retry-offline'),
  taskCountChip: document.querySelector('#task-count-chip'),
  tasks: document.querySelector('#tasks'),
  tasksError: document.querySelector('#tasks-error'),
  toggleProfileCreate: document.querySelector('#toggle-profile-create'),
  closeProfileCreate: document.querySelector('#close-profile-create'),
  profileCreatePanel: document.querySelector('#profile-create-panel'),
  createProfileForm: document.querySelector('#create-profile-form'),
  createProfileSubmit: document.querySelector('#create-profile-submit'),
  profileName: document.querySelector('#profile-name'),
  profiles: document.querySelector('#profiles'),
  profilesError: document.querySelector('#profiles-error'),
  message: document.querySelector('#dashboard-message')
};

function t(key, values = {}) {
  const table = I18N[state.language] || I18N.en;
  let result = table[key] ?? I18N.en[key] ?? key;
  for (const [name, value] of Object.entries(values)) {
    result = result.replaceAll(`{${name}}`, String(value));
  }
  return result;
}

function applyStaticLanguage() {
  document.documentElement.lang = state.language;
  document.title = t('page.title');
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-aria-label]')) node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  ui.languageToggle.textContent = state.language === 'zh-CN' ? 'EN' : '中';
  ui.languageToggle.setAttribute('aria-label', state.language === 'zh-CN' ? 'Switch to English' : '切换到中文');
  ui.languageToggle.title = ui.languageToggle.getAttribute('aria-label');
}

function setLanguage(language) {
  state.language = language;
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch {}
  applyStaticLanguage();
  if (state.connected) {
    markConnected();
    ui.lastRefresh.textContent = t('connection.refreshed', { time: formatClock(state.lastRefreshAt) });
  } else if (!ui.offlineBanner.classList.contains('hidden')) {
    markOffline();
  }
  renderAll();
}

class HttpError extends Error {
  constructor(message, status = 0, code = 'REQUEST_FAILED') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request(path, { method = 'GET', body } = {}) {
  const upperMethod = method.toUpperCase();
  const attempts = upperMethod === 'GET' ? 2 : 1;
  const timeoutMs = upperMethod === 'GET' ? READ_REQUEST_TIMEOUT_MS : MUTATION_REQUEST_TIMEOUT_MS;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, {
        method: upperMethod,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.includes('application/json') ? await response.json() : null;
      if (!response.ok) {
        const detail = payload?.error || payload || {};
        throw new HttpError(detail.message || t('error.request', { status: response.status }), response.status, detail.code || payload?.code);
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') lastError = new HttpError(t('error.timeout'), 0, 'REQUEST_TIMEOUT');
      else if (error instanceof HttpError) lastError = error;
      else lastError = new HttpError(t('error.network'), 0, 'NETWORK_ERROR');
      if (attempt + 1 < attempts) await delay(READ_RETRY_DELAY_MS);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function dataFrom(payload) {
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
}

function listFrom(payload, key) {
  const value = dataFrom(payload);
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.[key]) ? value[key] : [];
}

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function button(label, className, action) {
  const node = element('button', `npc-btn ${className}`, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function setInlineError(node, message) {
  node.textContent = message || '';
  node.classList.toggle('hidden', !message);
}

function setToast(message, kind = 'success') {
  clearTimeout(state.toastTimer);
  ui.message.textContent = message;
  ui.message.className = `toast is-${kind}`;
  state.toastTimer = setTimeout(() => ui.message.classList.add('hidden'), 4_500);
}

function formatClock(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(state.language, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(date);
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function normalizeTaskState(task) {
  const value = String(task?.state || task?.status || 'running').toLowerCase();
  if (['completed', 'complete', 'finished', 'done', 'success', 'succeeded'].includes(value)) return 'finished';
  if (['failed', 'error'].includes(value)) return 'error';
  if (['cancelled', 'canceled', 'terminated', 'stopped'].includes(value)) return 'stopped';
  if (['waiting', 'waiting_user', 'paused', 'cooling_down', 'blocked'].includes(value)) return 'waiting';
  return 'running';
}

function taskTitle(task) {
  return task?.title || task?.name || task?.taskLabel || t('tasks.untitled');
}

function finiteNumber(...values) {
  return values.find((value) => Number.isFinite(value)) ?? null;
}

function taskProgress(task) {
  const source = task?.progress && typeof task.progress === 'object' ? task.progress : {};
  const current = Math.max(0, finiteNumber(source.current, source.processed, task?.processed, task?.processedCount) ?? 0);
  const totalValue = finiteNumber(source.total, task?.total, task?.totalCount);
  const total = totalValue !== null && totalValue > 0 ? totalValue : null;
  const explicitPercent = finiteNumber(source.percent, task?.percent);
  const percent = explicitPercent !== null
    ? Math.min(100, Math.max(0, explicitPercent))
    : total === null ? null : Math.min(100, Math.max(0, (current / total) * 100));
  const message = source.message || task?.currentAction || task?.currentActivity?.message || task?.currentActivity?.phase || '';
  return {
    current,
    total,
    percent,
    message,
    amount: total === null ? t('tasks.processed', { current }) : `${current} / ${total}`
  };
}

function taskActivity(task) {
  const status = normalizeTaskState(task);
  return taskProgress(task).message || t(`activity.${status}`);
}

function taskElapsed(task, at = Date.now()) {
  const fixed = finiteNumber(task?.elapsedMs, task?.timing?.totalDurationMs, task?.timing?.elapsedMs);
  if (fixed !== null) {
    if (!TERMINAL_STATES.has(normalizeTaskState(task)) && task?.updatedAt) {
      return fixed + Math.max(0, at - new Date(task.updatedAt).getTime());
    }
    return fixed;
  }
  const started = new Date(task?.startedAt || task?.createdAt).getTime();
  if (!Number.isFinite(started)) return null;
  const ended = TERMINAL_STATES.has(normalizeTaskState(task))
    ? new Date(task?.endedAt || task?.completedAt || task?.updatedAt).getTime()
    : at;
  return Math.max(0, (Number.isFinite(ended) ? ended : at) - started);
}

function taskProfileName(task) {
  return task?.profileName || state.profiles.find((profile) => profile.id === task?.profileId)?.name || task?.profileId || '—';
}

function canResumeTask(task) {
  if (typeof task?.canResume === 'boolean') return task.canResume;
  if (typeof task?.resumeAvailable === 'boolean') return task.resumeAvailable;
  return ['waiting', 'stopped'].includes(normalizeTaskState(task));
}

function profileState(profile) {
  const value = String(profile?.runtime?.state || profile?.state || 'closed').toLowerCase();
  if (['open', 'manual_open', 'manual'].includes(value)) return 'open';
  if (['leased', 'in_use', 'busy', 'running', 'starting', 'closing'].includes(value)) return 'inUse';
  if (['error', 'quarantined'].includes(value)) return 'error';
  return 'closed';
}

function isDefaultProfile(profile) {
  return profile?.isDefault === true || profile?.default === true || profile?.id === state.defaultProfileId;
}

function profileLastUsed(profile) {
  return formatClock(profile?.lastUsedAt || profile?.updatedAt || profile?.createdAt);
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

function labelledValue(label, value, duration = false, taskId = '') {
  const group = element('span', 'labelled-value');
  group.append(element('small', '', label), element('strong', duration ? 'npc-number' : '', value));
  if (duration) {
    const valueNode = group.querySelector('strong');
    valueNode.dataset.taskDuration = taskId;
  }
  return group;
}

function taskActionButtons(task) {
  const actions = element('div', 'task-actions');
  const status = normalizeTaskState(task);
  const pending = state.pending.has(`task:${task.id}`);
  if (!TERMINAL_STATES.has(status)) {
    const stop = button(t('tasks.stop'), 'npc-btn-secondary compact-button', () => void sendTaskAction(task, 'stop'));
    stop.disabled = pending;
    actions.append(stop);
  }
  if (canResumeTask(task)) {
    const resume = button(t('tasks.resume'), 'npc-btn-primary compact-button', () => void sendTaskAction(task, 'resume'));
    resume.disabled = pending;
    actions.append(resume);
  }
  const remove = button(t('tasks.delete'), 'npc-btn-danger compact-button', () => void deleteTask(task));
  remove.disabled = pending;
  actions.append(remove);
  return actions;
}

function renderTasks() {
  const ordered = [...state.tasks].sort((left, right) => {
    const leftTerminal = TERMINAL_STATES.has(normalizeTaskState(left));
    const rightTerminal = TERMINAL_STATES.has(normalizeTaskState(right));
    if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
    return Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0);
  });
  ui.tasks.replaceChildren();
  if (!ordered.length) {
    ui.tasks.append(element('p', 'empty-state', t('tasks.empty')));
  }
  for (const task of ordered) {
    const status = normalizeTaskState(task);
    const progress = taskProgress(task);
    const card = element('article', `task-card task-${status}`);
    card.dataset.taskId = task.id;
    card.tabIndex = -1;
    if (state.targetedTaskId === task.id) card.classList.add('is-targeted');

    const heading = element('div', 'card-heading');
    const headingCopy = element('div', 'card-title');
    headingCopy.append(element('h2', '', taskTitle(task)), element('p', 'task-activity', taskActivity(task)));
    heading.append(headingCopy, element('span', `npc-chip task-state-${status}`, t(`state.${status}`)));

    const progressBlock = element('div', 'task-progress-block');
    const progressCopy = element('div', 'progress-copy');
    progressCopy.append(element('span', '', progress.message || taskActivity(task)), element('strong', 'npc-number', progress.amount));
    const track = element('div', `progress-track${progress.percent === null ? ' is-indeterminate' : ''}`);
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', t('tasks.progressAria', { title: taskTitle(task) }));
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    if (progress.percent === null) track.setAttribute('aria-valuetext', t('tasks.progressUnknown'));
    else track.setAttribute('aria-valuenow', String(Math.round(progress.percent)));
    const bar = element('span', 'progress-bar');
    if (progress.percent !== null) bar.style.width = `${progress.percent}%`;
    track.append(bar);
    progressBlock.append(progressCopy, track);

    const facts = element('div', 'task-facts');
    facts.append(
      labelledValue(t('tasks.profile'), taskProfileName(task)),
      labelledValue(t('tasks.elapsed'), formatDuration(taskElapsed(task)), true, task.id),
      labelledValue(t('tasks.updated'), formatClock(task.updatedAt || task.progress?.updatedAt || task.createdAt))
    );

    const footer = element('div', 'card-footer');
    footer.append(taskActionButtons(task));
    card.append(heading, progressBlock, facts, footer);
    ui.tasks.append(card);
  }
  const active = state.tasks.filter((task) => !TERMINAL_STATES.has(normalizeTaskState(task))).length;
  ui.taskCountChip.textContent = t('tasks.count', { active, total: state.tasks.length });
  setInlineError(ui.tasksError, state.errors.tasks);
  focusInitialTask();
}

function renderProfiles() {
  const ordered = [...state.profiles].sort((left, right) => {
    if (isDefaultProfile(left) !== isDefaultProfile(right)) return isDefaultProfile(left) ? -1 : 1;
    return String(left.name || '').localeCompare(String(right.name || ''), state.language);
  });
  ui.profiles.replaceChildren();
  if (!ordered.length) ui.profiles.append(element('p', 'empty-state span-all', t('profiles.empty')));
  for (const profile of ordered) {
    const status = profileState(profile);
    const pending = state.pending.has(`profile:${profile.id}`);
    const card = element('article', `profile-card profile-state-${status}`);

    const heading = element('div', 'card-heading');
    const headingCopy = element('div', 'card-title');
    headingCopy.append(element('p', 'npc-eyebrow', 'CHROME'), element('h2', '', profile.name || profile.id));
    const chips = element('div', 'profile-chips');
    if (isDefaultProfile(profile)) chips.append(element('span', 'npc-chip npc-chip-default', t('profiles.default')));
    chips.append(element('span', `npc-chip profile-status-${status}`, t(`profileState.${status}`)));
    heading.append(headingCopy, chips);

    const facts = element('div', 'profile-facts');
    facts.append(
      labelledValue(t('profiles.browser'), t('profiles.chrome')),
      labelledValue(t('profiles.recent'), profileLastUsed(profile))
    );

    const actions = element('div', 'profile-actions');
    if (!isDefaultProfile(profile)) {
      const makeDefault = button(t('profiles.setDefault'), 'npc-btn-secondary compact-button', () => void setDefaultProfile(profile));
      makeDefault.disabled = pending;
      actions.append(makeDefault);
    }
    if (status === 'inUse') {
      const busy = button(t('profiles.inUse'), 'npc-btn-secondary compact-button', () => {});
      busy.disabled = true;
      actions.append(busy);
    } else {
      const action = status === 'open' ? 'close' : 'open';
      const toggle = button(t(`profiles.${action}`), 'npc-btn-secondary compact-button', () => void setProfileWindow(profile, action));
      toggle.disabled = pending;
      actions.append(toggle);
    }
    const remove = button(t('common.delete'), 'npc-btn-danger compact-button', () => void deleteProfile(profile));
    remove.disabled = pending;
    actions.append(remove);
    card.append(heading, facts, actions);
    ui.profiles.append(card);
  }
  setInlineError(ui.profilesError, state.errors.profiles);
}

function renderAll() {
  renderTasks();
  renderProfiles();
}

function markConnected() {
  state.connected = true;
  ui.connectionDot.className = 'npc-signal-dot is-online';
  ui.connectionLabel.textContent = t('connection.online');
  ui.offlineBanner.classList.add('hidden');
}

function markOffline() {
  state.connected = false;
  ui.connectionDot.className = 'npc-signal-dot is-offline';
  ui.connectionLabel.textContent = t('connection.offline');
  ui.offlineBanner.classList.remove('hidden');
}

function statusData(payload) {
  const value = dataFrom(payload) || {};
  return value.status && typeof value.status === 'object' ? value.status : value;
}

async function refreshAll() {
  if (state.refreshPromise) {
    state.refreshAgain = true;
    return state.refreshPromise;
  }
  const sequence = ++state.refreshSequence;
  ui.refreshAll.disabled = true;
  ui.refreshAll.classList.add('is-loading');
  state.refreshPromise = (async () => {
    const results = await Promise.allSettled([
      request('/v1/status'),
      request('/v1/tasks'),
      request('/v1/profiles')
    ]);
    if (sequence !== state.refreshSequence) return;
    const [managerResult, tasksResult, profilesResult] = results;
    if (managerResult.status === 'fulfilled') {
      state.manager = statusData(managerResult.value);
      state.defaultProfileId = state.manager.defaultProfileId || state.manager.defaultProfile?.id || state.defaultProfileId;
    }
    if (tasksResult.status === 'fulfilled') {
      state.tasks = listFrom(tasksResult.value, 'tasks');
      state.errors.tasks = '';
    } else {
      state.errors.tasks = tasksResult.reason?.message || t('error.read');
    }
    if (profilesResult.status === 'fulfilled') {
      const value = dataFrom(profilesResult.value);
      state.profiles = listFrom(profilesResult.value, 'profiles');
      state.defaultProfileId = value?.defaultProfileId || state.profiles.find((profile) => profile.isDefault || profile.default)?.id || state.defaultProfileId;
      state.errors.profiles = '';
    } else {
      state.errors.profiles = profilesResult.reason?.message || t('error.read');
    }
    if (results.some((result) => result.status === 'fulfilled')) {
      markConnected();
      state.lastRefreshAt = Date.now();
      ui.lastRefresh.textContent = t('connection.refreshed', { time: formatClock(state.lastRefreshAt) });
    } else {
      markOffline();
    }
    renderAll();
  })();
  try {
    await state.refreshPromise;
  } finally {
    state.refreshPromise = null;
    ui.refreshAll.disabled = false;
    ui.refreshAll.classList.remove('is-loading');
    if (state.refreshAgain) {
      state.refreshAgain = false;
      void refreshAll();
    }
  }
}

function pollingDelay() {
  if (document.visibilityState === 'hidden') return 15_000;
  return state.tasks.some((task) => !TERMINAL_STATES.has(normalizeTaskState(task))) ? 2_000 : 6_000;
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
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  for (const node of document.querySelectorAll('[data-task-duration]')) {
    const task = tasks.get(node.dataset.taskDuration);
    if (task) node.textContent = formatDuration(taskElapsed(task));
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

async function runMutation(key, section, operation, successMessage) {
  if (state.pending.has(key)) return null;
  state.pending.add(key);
  renderAll();
  try {
    const result = await operation();
    state.errors[section] = '';
    if (successMessage) setToast(successMessage, 'success');
    return result;
  } catch (error) {
    const message = error.code === 'PROFILE_NAME_EXISTS' ? t('error.nameExists') : error.message || t('error.operation');
    state.errors[section] = message;
    setToast(message, 'error');
    return null;
  } finally {
    state.pending.delete(key);
    await refreshAll();
  }
}

async function sendTaskAction(task, action) {
  const payload = await runMutation(`task:${task.id}`, 'tasks', () => request(`/v1/tasks/${encodeURIComponent(task.id)}/actions`, {
    method: 'POST', body: { action }
  }), t(action === 'stop' ? 'toast.taskStopped' : 'toast.taskResumed'));
  const updated = dataFrom(payload)?.task;
  if (updated?.id) {
    const index = state.tasks.findIndex((candidate) => candidate.id === updated.id);
    if (index >= 0) state.tasks[index] = updated;
  }
}

async function deleteTask(task) {
  if (!confirm(t('confirm.deleteTask', { title: taskTitle(task) }))) return;
  const result = await runMutation(`task:${task.id}`, 'tasks', () => request(`/v1/tasks/${encodeURIComponent(task.id)}`, {
    method: 'DELETE'
  }), t('toast.taskDeleted'));
  if (result !== null) {
    state.tasks = state.tasks.filter((candidate) => candidate.id !== task.id);
    if (state.targetedTaskId === task.id) {
      state.targetedTaskId = '';
      const url = new URL(location.href);
      url.searchParams.delete('task');
      history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
    renderTasks();
  }
}

function profileCreateVisible(visible) {
  ui.profileCreatePanel.classList.toggle('hidden', !visible);
  ui.toggleProfileCreate.setAttribute('aria-expanded', String(visible));
  if (visible) ui.profileName.focus();
  else ui.toggleProfileCreate.focus();
}

async function createProfile(event) {
  event.preventDefault();
  const name = ui.profileName.value.trim();
  if (!name) return;
  const result = await runMutation('profile:create', 'profiles', () => request('/v1/profiles', {
    method: 'POST', body: { name }
  }), t('toast.profileCreated'));
  if (result !== null) {
    ui.createProfileForm.reset();
    profileCreateVisible(false);
  }
}

async function setDefaultProfile(profile) {
  await runMutation(`profile:${profile.id}`, 'profiles', () => request(`/v1/profiles/${encodeURIComponent(profile.id)}`, {
    method: 'PATCH', body: { isDefault: true }
  }), t('toast.profileDefault'));
}

async function setProfileWindow(profile, action) {
  await runMutation(`profile:${profile.id}`, 'profiles', () => request(`/v1/profiles/${encodeURIComponent(profile.id)}/actions`, {
    method: 'POST', body: { action }
  }), t(action === 'open' ? 'toast.profileOpened' : 'toast.profileClosed'));
}

async function deleteProfile(profile) {
  if (!confirm(t('confirm.deleteProfile', { name: profile.name || profile.id }))) return;
  const result = await runMutation(`profile:${profile.id}`, 'profiles', () => request(`/v1/profiles/${encodeURIComponent(profile.id)}`, {
    method: 'DELETE'
  }), t('toast.profileDeleted'));
  if (result !== null) {
    state.profiles = state.profiles.filter((candidate) => candidate.id !== profile.id);
    renderProfiles();
  }
}

async function focusInitialTask() {
  if (state.initialTaskFocused || state.initialTaskFocusPending || !state.targetedTaskId) return;
  state.initialTaskFocusPending = true;
  try {
    let task = state.tasks.find((candidate) => candidate.id === state.targetedTaskId);
    if (!task) {
      const payload = await request(`/v1/tasks/${encodeURIComponent(state.targetedTaskId)}`);
      task = dataFrom(payload)?.task || dataFrom(payload);
      if (task?.id) {
        state.tasks.push(task);
        renderTasks();
      }
    }
    if (!task?.id) throw new HttpError(t('tasks.targetMissing'), 404, 'TASK_NOT_FOUND');
    state.initialTaskFocused = true;
    const card = ui.tasks.querySelector(`[data-task-id="${CSS.escape(task.id)}"]`);
    if (card) {
      card.classList.add('is-targeted');
      card.focus();
      card.scrollIntoView({ block: 'center' });
    }
  } catch {
    if (!state.initialTaskFocused) {
      setToast(t('tasks.targetMissing'), 'error');
      state.targetedTaskId = '';
    }
  } finally {
    state.initialTaskFocusPending = false;
  }
}

for (const link of ui.navLinks) link.addEventListener('click', () => setView(link.dataset.view));
ui.languageToggle.addEventListener('click', () => setLanguage(state.language === 'zh-CN' ? 'en' : 'zh-CN'));
ui.refreshAll.addEventListener('click', () => void refreshAll());
ui.retryOffline.addEventListener('click', () => void refreshAll());
ui.toggleProfileCreate.addEventListener('click', () => profileCreateVisible(true));
ui.closeProfileCreate.addEventListener('click', () => profileCreateVisible(false));
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
  void refreshAll();
  scheduleRefresh();
  scheduleDurationTick();
});

const initialUrl = new URL(location.href);
state.targetedTaskId = initialUrl.searchParams.get('task') || '';
applyStaticLanguage();
setView(initialUrl.searchParams.get('view') || 'tasks', { updateHistory: false, focus: false });
void refreshAll().finally(() => {
  scheduleRefresh();
  scheduleDurationTick();
});
