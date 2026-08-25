const REQUEST_TIMEOUT_MS = 10_000;
const READ_RETRY_DELAY_MS = 300;
const VIEWS = new Set(['overview', 'agents', 'profiles', 'tasks']);
const ACTIVE_TASK_STATES = new Set([
  'queued', 'acquiring_profile', 'starting_browser', 'running', 'cooling_down',
  'recovering', 'verifying', 'pause_requested', 'cancel_requested', 'cancelling'
]);
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled', 'terminated']);
const ATTENTION_TASK_STATES = new Set(['waiting_user', 'failed', 'stalled']);
const TASK_STATE_LABELS = Object.freeze({
  queued: '排队中',
  acquiring_profile: '准备 Profile',
  starting_browser: '启动浏览器',
  running: '执行中',
  pause_requested: '正在暂停',
  paused: '已暂停',
  waiting_user: '等待指令',
  cooling_down: '限流冷却',
  recovering: '恢复中',
  verifying: '验收中',
  cancel_requested: '正在终止',
  cancelling: '正在终止',
  completed: '已完成',
  failed: '失败',
  cancelled: '已终止',
  terminated: '已终止'
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
  waiting_user: '等待你的指令',
  cooling_down: '正在等待限流恢复',
  recovering: '正在从检查点恢复',
  verifying: '正在验收结果',
  reporting: 'Agent 正在生成报告',
  cleaning_up: '正在关闭任务窗口',
  paused: '任务已暂停',
  completed: '任务已完成',
  failed: '任务失败',
  cancel_requested: '正在安全终止任务',
  cancelled: '任务已终止'
});

const ui = Object.freeze({
  navLinks: [...document.querySelectorAll('[data-view]')],
  viewPanels: [...document.querySelectorAll('[data-view-panel]')],
  openViewLinks: [...document.querySelectorAll('[data-open-view]')],
  connectionDot: document.querySelector('#connection-dot'),
  connectionLabel: document.querySelector('#connection-label'),
  lastRefresh: document.querySelector('#last-refresh'),
  refreshAll: document.querySelector('#refresh-all'),
  logoutButton: document.querySelector('#logout-button'),
  authBanner: document.querySelector('#auth-banner'),
  retryAuth: document.querySelector('#retry-auth'),
  staleBanner: document.querySelector('#stale-banner'),
  retryStale: document.querySelector('#retry-stale'),
  managerStageDot: document.querySelector('#manager-stage-dot'),
  managerStageLabel: document.querySelector('#manager-stage-label'),
  managerStageMeta: document.querySelector('#manager-stage-meta'),
  summaryAgents: document.querySelector('#summary-agents'),
  summaryOnlineAgents: document.querySelector('#summary-online-agents'),
  summaryProfiles: document.querySelector('#summary-profiles'),
  summaryRunning: document.querySelector('#summary-running'),
  summaryQueued: document.querySelector('#summary-queued'),
  summaryAttention: document.querySelector('#summary-attention'),
  attentionList: document.querySelector('#attention-list'),
  recentReports: document.querySelector('#recent-reports'),
  agents: document.querySelector('#agents'),
  agentCountChip: document.querySelector('#agent-count-chip'),
  agentsError: document.querySelector('#agents-error'),
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
  tasks: document.querySelector('#tasks'),
  tasksError: document.querySelector('#tasks-error'),
  taskSearch: document.querySelector('#task-search'),
  taskAgentFilter: document.querySelector('#task-agent-filter'),
  taskStateFilter: document.querySelector('#task-state-filter'),
  message: document.querySelector('#dashboard-message'),
  taskDialog: document.querySelector('#task-detail-dialog'),
  closeTaskDetail: document.querySelector('#close-task-detail'),
  taskDetailTitle: document.querySelector('#task-detail-title'),
  taskDetailMeta: document.querySelector('#task-detail-meta'),
  taskDetailLoading: document.querySelector('#task-detail-loading'),
  taskDetailContent: document.querySelector('#task-detail-content'),
  taskDetailError: document.querySelector('#task-detail-error'),
  detailActivity: document.querySelector('#detail-activity'),
  detailProgressCopy: document.querySelector('#detail-progress-copy'),
  detailProgressTrack: document.querySelector('#detail-progress-track'),
  detailProgressBar: document.querySelector('#detail-progress-bar'),
  detailProgressMessage: document.querySelector('#detail-progress-message'),
  taskPause: document.querySelector('#task-pause'),
  taskResume: document.querySelector('#task-resume'),
  taskTerminate: document.querySelector('#task-terminate'),
  taskModify: document.querySelector('#task-modify'),
  taskAsk: document.querySelector('#task-ask'),
  reportStatus: document.querySelector('#report-status'),
  taskReport: document.querySelector('#task-report'),
  commandPanel: document.querySelector('#command-panel'),
  commandTitle: document.querySelector('#command-title'),
  commandTarget: document.querySelector('#command-target'),
  taskCommandForm: document.querySelector('#task-command-form'),
  commandKind: document.querySelector('#command-kind'),
  commandText: document.querySelector('#command-text'),
  commandHelp: document.querySelector('#command-help'),
  sendCommand: document.querySelector('#send-command'),
  taskTimeline: document.querySelector('#task-timeline'),
  taskArtifacts: document.querySelector('#task-artifacts'),
  developerDiagnostics: document.querySelector('#developer-diagnostics')
});

const state = {
  authenticated: null,
  stale: false,
  visibleView: 'overview',
  summary: {},
  agents: [],
  profiles: [],
  tasks: [],
  selectedTaskId: '',
  selectedTask: null,
  selectedArtifacts: [],
  sectionErrors: {},
  mutationErrors: {},
  renderSignatures: new Map(),
  pendingMutations: new Set(),
  agentActionLocks: new Map(),
  pendingFocusKey: '',
  focusIntentSequence: 0,
  refreshSequence: 0,
  detailSequence: 0,
  refreshPromise: null,
  refreshAgain: false,
  refreshTimer: null,
  stopped: false,
  openedInitialTask: false,
  toastTimer: null,
  returnFocus: null
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

function recordFrom(payload, key) {
  const data = dataFrom(payload);
  if (data?.[key] && typeof data[key] === 'object') return data[key];
  if (payload?.[key] && typeof payload[key] === 'object') return payload[key];
  return data && typeof data === 'object' ? data : {};
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
    // A repeated bootstrap link may be expired while an existing Owner cookie
    // is still valid. The normal refresh below is the source of truth.
    if (error.status !== 401) throw error;
  }
}

function markAuthorizationRequired() {
  state.authenticated = false;
  state.stale = false;
  state.refreshSequence += 1;
  state.detailSequence += 1;
  state.summary = {};
  state.agents = [];
  state.profiles = [];
  state.tasks = [];
  state.selectedTaskId = '';
  state.selectedTask = null;
  state.selectedArtifacts = [];
  state.sectionErrors = {};
  state.mutationErrors = {};
  state.pendingMutations.clear();
  state.renderSignatures.clear();
  state.openedInitialTask = false;
  state.returnFocus = null;
  state.pendingFocusKey = '';
  state.focusIntentSequence += 1;
  ui.commandText.value = '';
  ui.taskDetailMeta.replaceChildren();
  ui.taskReport.replaceChildren();
  ui.taskTimeline.replaceChildren();
  ui.taskArtifacts.replaceChildren();
  ui.developerDiagnostics.textContent = '';
  setInlineError(ui.taskDetailError);
  if (ui.taskDialog.open) ui.taskDialog.close();
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
  let stage = '正在建立连接';
  if (mode === 'connected') {
    dotClasses.push('is-online');
    label = '本机 Manager 在线';
    stage = 'Manager 正常运行';
  } else if (mode === 'unauthorized') {
    dotClasses.push('is-offline');
    label = '需要建立 Owner 会话';
    stage = '等待 Owner 会话';
  } else if (mode === 'stale') {
    dotClasses.push('is-warning');
    label = '连接中断 · 自动重试';
    stage = '保留上次状态';
  } else {
    dotClasses.push('is-pending');
  }
  ui.connectionDot.className = dotClasses.join(' ');
  ui.managerStageDot.className = dotClasses.join(' ');
  ui.connectionLabel.textContent = label;
  ui.managerStageLabel.textContent = stage;
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

function mutationSection(key) {
  if (key.startsWith('agent:')) return 'agents';
  if (key.startsWith('profile:')) return 'profiles';
  if (key.startsWith('task:')) return 'tasks';
  return '';
}

function formatTime(value, { relative = false } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  if (relative) {
    const seconds = Math.round((date.valueOf() - Date.now()) / 1000);
    const absolute = Math.abs(seconds);
    const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
    if (absolute < 60) return formatter.format(seconds, 'second');
    if (absolute < 3_600) return formatter.format(Math.round(seconds / 60), 'minute');
    if (absolute < 86_400) return formatter.format(Math.round(seconds / 3_600), 'hour');
  }
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function taskState(task) {
  return task?.state || task?.status || 'unknown';
}

function taskStateLabel(task) {
  const value = taskState(task);
  return TASK_STATE_LABELS[value] || value.replaceAll('_', ' ');
}

function taskAgent(task) {
  const source = task?.agent || {};
  return {
    id: source.id || source.agentId || source.clientId || task?.agentId || task?.createdBy || '',
    name: source.displayName || source.name || source.clientId || task?.agentName || task?.createdBy || 'Manager'
  };
}

function taskTitle(task) {
  return task?.title || task?.name || task?.taskTypeTitle || task?.taskType || task?.id || '未命名任务';
}

function taskActivity(task) {
  const activity = task?.currentActivity || {};
  const phase = activity.phase || task?.progress?.phase || taskState(task);
  return {
    phase,
    label: ACTIVITY_LABELS[phase] || activity.message || taskStateLabel(task),
    message: activity.message || activity.label || task?.progress?.message || '',
    updatedAt: activity.updatedAt || task?.progress?.updatedAt || task?.updatedAt
  };
}

function taskProgress(task) {
  const current = Number(task?.progress?.current);
  const total = Number(task?.progress?.total);
  let percent = Number(task?.progress?.percent);
  if (!Number.isFinite(percent) && Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    percent = current / total * 100;
  }
  percent = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
  return {
    current: Number.isFinite(current) ? current : null,
    total: Number.isFinite(total) ? total : null,
    percent,
    message: task?.progress?.message || taskActivity(task).message
  };
}

function reportData(task) {
  const result = task?.result && typeof task.result === 'object' ? task.result : {};
  const source = task?.report || task?.finalReport || result.report || result.finalReport || result;
  const object = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const markdown = object.reportMarkdown || object.markdown || object.body || task?.reportMarkdown || '';
  const summary = object.executiveSummary || object.summary || task?.summary || '';
  const title = object.title || taskTitle(task);
  const highlights = Array.isArray(object.highlights) ? object.highlights : [];
  const caveats = Array.isArray(object.caveats) ? object.caveats : [];
  const sections = Array.isArray(object.sections)
    ? object.sections.filter((section) => section && typeof section === 'object').slice(0, 24)
    : [];
  const metrics = object.metrics && typeof object.metrics === 'object' ? object.metrics : null;
  const publishedAt = object.generatedAt || object.publishedAt || task?.reportPublishedAt || '';
  return {
    title,
    summary,
    markdown: typeof markdown === 'string' ? markdown : '',
    highlights,
    caveats,
    sections,
    metrics,
    publishedAt,
    exists: Boolean(summary || markdown || highlights.length || caveats.length || sections.length || metrics)
  };
}

function reportSummary(task) {
  const report = reportData(task);
  if (report.summary) return report.summary;
  if (report.markdown) {
    return report.markdown.replace(/[#>*_`|\[\]()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  }
  if (taskState(task) === 'completed') return '浏览器任务已完成，等待 Agent 发布最终报告。';
  return taskActivity(task).message || taskActivity(task).label;
}

function agentStatus(agent) {
  if (agent?.revokedAt || agent?.revoked === true || agent?.status === 'revoked') return 'revoked';
  if (agent?.status === 'working' || agent?.working === true || Number(agent?.activeTaskCount) > 0 || agent?.currentTaskIds?.length > 0) return 'working';
  if (agent?.status === 'online' || agent?.online === true || Number(agent?.connectionCount ?? agent?.activeConnectionCount) > 0) return 'online';
  return agent?.status || 'offline';
}

function agentStatusLabel(status) {
  return ({ registered: '已接入', online: '在线', working: '执行中', offline: '离线', revoked: '已撤销' })[status] || status;
}

function agentId(agent) {
  return agent?.id || agent?.agentId || agent?.clientId || '';
}

function agentName(agent) {
  return agent?.displayName || agent?.name || agent?.clientName || agentId(agent) || '未命名 Agent';
}

function profileState(profile) {
  return profile?.state || profile?.status || 'idle';
}

function profileMode(profile) {
  if (profile?.kind !== 'ephemeral') return 'human';
  return ['fast', 'adaptive', 'human'].includes(profile?.defaultBehavior) ? profile.defaultBehavior : 'adaptive';
}

function profileEngine(profile) {
  return profile?.browserEngine === 'chrome' ? '本机 Chrome' : '项目 Chromium';
}

function containsInteractiveFocus(container) {
  const active = document.activeElement;
  return Boolean(active && container.contains(active) && active.matches('button, input, select, textarea, a, summary'));
}

function renderWhenChanged(key, data, container, renderer, force = false) {
  const signature = JSON.stringify(data);
  if (!force && state.renderSignatures.get(key) === signature) return;
  if (!force && containsInteractiveFocus(container)) return;
  renderer();
  state.renderSignatures.set(key, signature);
}

function setView(view, { updateHistory = true, focus = true } = {}) {
  const next = VIEWS.has(view) ? view : 'overview';
  state.visibleView = next;
  for (const link of ui.navLinks) {
    const active = link.dataset.view === next;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const panel of ui.viewPanels) {
    const active = panel.dataset.viewPanel === next;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  }
  if (updateHistory) {
    const url = new URL(location.href);
    if (next === 'overview') url.searchParams.delete('view');
    else url.searchParams.set('view', next);
    history.pushState(null, '', `${url.pathname}${url.search}`);
  }
  if (focus) document.querySelector(`#view-${next} h1`)?.focus?.({ preventScroll: true });
}

function focusKey(node, value) {
  node.dataset.focusKey = value;
  return node;
}

function isAgentActionLocked(id) {
  return (state.agentActionLocks.get(id) ?? 0) > Date.now();
}

function restoreFocus(focusKeyValue) {
  if (!focusKeyValue) return false;
  const target = [...document.querySelectorAll('[data-focus-key]')]
    .find((node) => node.dataset.focusKey === focusKeyValue && !node.disabled);
  target?.focus({ preventScroll: true });
  return document.activeElement === target;
}

function taskMatchesFilter(task) {
  const search = ui.taskSearch.value.trim().toLocaleLowerCase();
  const selectedAgent = ui.taskAgentFilter.value;
  const selectedState = ui.taskStateFilter.value;
  const agent = taskAgent(task);
  const stateValue = taskState(task);
  const haystack = `${taskTitle(task)} ${task.id || ''} ${agent.name} ${agent.id} ${task.profileName || ''} ${task.profileId || ''}`.toLocaleLowerCase();
  if (search && !haystack.includes(search)) return false;
  if (selectedAgent && agent.id !== selectedAgent) return false;
  if (selectedState === 'active' && !ACTIVE_TASK_STATES.has(stateValue) && stateValue !== 'paused') return false;
  if (selectedState === 'attention' && !ATTENTION_TASK_STATES.has(stateValue) && task?.health?.status !== 'stalled') return false;
  if (selectedState === 'completed' && stateValue !== 'completed') return false;
  if (selectedState === 'cancelled' && !['cancelled', 'terminated'].includes(stateValue)) return false;
  return true;
}

function renderSummary() {
  const explicit = state.summary || {};
  const onlineAgents = state.agents.filter((agent) => ['online', 'working'].includes(agentStatus(agent))).length;
  const running = state.tasks.filter((task) => ACTIVE_TASK_STATES.has(taskState(task))).length;
  const queued = state.tasks.filter((task) => taskState(task) === 'queued').length;
  const attention = state.tasks.filter((task) => (
    ATTENTION_TASK_STATES.has(taskState(task)) || task?.health?.status === 'stalled'
  )).length;
  const agentCount = explicit.agentCount ?? explicit.agents?.total ?? state.agents.length;
  const onlineCount = explicit.onlineAgentCount ?? explicit.agents?.online ?? onlineAgents;
  const profileCount = explicit.profileCount ?? explicit.profiles?.total ?? state.profiles.length;
  const runningCount = explicit.runningTaskCount ?? explicit.tasks?.running ?? running;
  const queuedCount = explicit.queuedTaskCount ?? explicit.tasks?.queued ?? queued;
  const attentionCount = explicit.attentionTaskCount ?? explicit.tasks?.attention ?? attention;
  const hasData = state.authenticated === true;

  ui.summaryAgents.textContent = hasData ? String(agentCount) : '—';
  ui.summaryOnlineAgents.textContent = hasData ? `${onlineCount} 在线` : '— 在线';
  ui.summaryProfiles.textContent = hasData ? String(profileCount) : '—';
  ui.summaryRunning.textContent = hasData ? String(runningCount) : '—';
  ui.summaryQueued.textContent = hasData ? `${queuedCount} 排队` : '— 排队';
  ui.summaryAttention.textContent = hasData ? String(attentionCount) : '—';
  const version = explicit.version || explicit.manager?.version || '';
  const uptime = explicit.uptime || explicit.manager?.uptime || '';
  ui.managerStageMeta.textContent = [version && `v${version}`, uptime, 'THIS DEVICE · OWNER CONSOLE'].filter(Boolean).join(' · ');
}

function renderOverview(force = false) {
  const attentionTasks = state.tasks.filter((task) => (
    ATTENTION_TASK_STATES.has(taskState(task)) || task?.health?.status === 'stalled'
  )).slice(0, 5);
  renderWhenChanged('overview-attention', attentionTasks, ui.attentionList, () => {
    ui.attentionList.replaceChildren();
    if (!attentionTasks.length) {
      ui.attentionList.append(element('p', 'empty-state good-state', '当前没有需要人工介入的任务。'));
      return;
    }
    for (const task of attentionTasks) {
      const item = button('', 'compact-item attention-item', () => openTaskDetail(task.id));
      item.setAttribute('aria-label', `查看任务 ${taskTitle(task)}`);
      const copy = element('span', 'compact-item-copy');
      copy.append(element('strong', '', taskTitle(task)), element('small', '', taskActivity(task).message || taskStateLabel(task)));
      item.append(copy, element('span', 'npc-chip npc-chip-warning', taskStateLabel(task)));
      ui.attentionList.append(item);
    }
  }, force);

  const completed = state.tasks.filter((task) => taskState(task) === 'completed').slice(0, 5);
  renderWhenChanged('overview-reports', completed, ui.recentReports, () => {
    ui.recentReports.replaceChildren();
    if (!completed.length) {
      ui.recentReports.append(element('p', 'empty-state', '还没有已完成的任务报告。'));
      return;
    }
    for (const task of completed) {
      const report = reportData(task);
      const item = button('', 'compact-item report-item', () => openTaskDetail(task.id));
      const copy = element('span', 'compact-item-copy');
      copy.append(
        element('strong', '', report.title || taskTitle(task)),
        element('small', '', report.summary || '浏览器执行已完成，等待 Agent 发布最终报告。')
      );
      item.append(copy, element('time', '', formatTime(report.publishedAt || task.finishedAt, { relative: true })));
      ui.recentReports.append(item);
    }
  }, force);
}

function renderAgents(force = false) {
  renderWhenChanged('agents', state.agents, ui.agents, () => {
    ui.agents.replaceChildren();
    if (!state.agents.length) {
      ui.agents.append(element('p', 'empty-state span-all', '还没有 Agent 接入 Manager。'));
      return;
    }
    for (const agent of state.agents) {
      const id = agentId(agent);
      const status = agentStatus(agent);
      const declaredTaskIds = new Set(Array.isArray(agent.currentTaskIds) ? agent.currentTaskIds : []);
      const activeTasks = state.tasks.filter((task) => (
        (taskAgent(task).id === id || declaredTaskIds.has(task.id)) && !TERMINAL_TASK_STATES.has(taskState(task))
      ));
      const card = element('article', `agent-card status-${status}`);
      const heading = element('div', 'card-heading');
      const identity = element('div', 'agent-identity');
      identity.append(
        element('span', 'agent-avatar', agentName(agent).slice(0, 2).toUpperCase()),
        element('span', 'agent-name-block')
      );
      identity.lastChild.append(element('h2', '', agentName(agent)), element('code', '', id || '无稳定 ID'));
      heading.append(identity, element('span', `npc-chip status-chip status-${status}`, agentStatusLabel(status)));

      const stats = element('dl', 'agent-stats');
      const values = [
        ['当前任务', activeTasks.length || declaredTaskIds.size || Number(agent.activeTaskCount) || 0],
        ['在线连接', Number(agent.connectionCount ?? agent.activeConnectionCount) || (status === 'online' || status === 'working' ? 1 : 0)],
        ['最近活动', formatTime(agent.lastSeenAt || agent.lastActivityAt, { relative: true })]
      ];
      for (const [label, value] of values) {
        const group = element('div');
        group.append(element('dt', '', label), element('dd', 'npc-number', value));
        stats.append(group);
      }

      const current = element('div', 'agent-current');
      if (activeTasks.length) {
        current.append(
          element('small', '', 'CURRENT TASK'),
          button(taskTitle(activeTasks[0]), 'text-link', () => openTaskDetail(activeTasks[0].id))
        );
      } else {
        current.append(element('small', '', '当前没有活动任务'));
      }

      const footer = element('div', 'card-footer');
      footer.append(element('span', 'muted-copy', `接入于 ${formatTime(agent.registeredAt || agent.createdAt)}`));
      const accessButton = button(
        status === 'revoked' ? '恢复接入' : '撤销接入',
        `${status === 'revoked' ? 'npc-btn-secondary' : 'npc-btn-danger'} compact-button`,
        () => setAgentAccess(agent)
      );
      focusKey(accessButton, `agent:${id}:access`);
      accessButton.disabled = !id || isPending(`agent:${id}`) || isAgentActionLocked(id);
      footer.append(accessButton);
      card.append(heading, stats, current, footer);
      ui.agents.append(card);
    }
  }, force);
  ui.agentCountChip.textContent = `${state.agents.length} 个已登记 Agent`;
  setInlineError(ui.agentsError, state.mutationErrors.agents || state.sectionErrors.agents || '');
}

function renderProfiles(force = false) {
  renderWhenChanged('profiles', state.profiles, ui.profiles, () => {
    ui.profiles.replaceChildren();
    if (!state.profiles.length) {
      ui.profiles.append(element('p', 'empty-state span-all', '还没有 Profile。创建一个独立浏览器环境开始任务。'));
      return;
    }
    for (const profile of state.profiles) {
      const id = profile.id;
      const currentState = profileState(profile);
      const persistent = profile.kind !== 'ephemeral';
      const busy = !['idle', 'closed'].includes(currentState);
      const card = element('article', `profile-card profile-${profile.kind || 'persistent'}`);
      const heading = element('div', 'card-heading');
      const title = element('div');
      title.append(
        element('p', 'npc-eyebrow', persistent ? 'PERSISTENT PROFILE' : 'EPHEMERAL PROFILE'),
        element('h2', '', profile.name || id)
      );
      heading.append(title, element('span', `npc-chip status-chip profile-state-${currentState}`, ({ idle: '空闲', open: '人工打开', leased: '任务占用', starting: '启动中', error: '需检查' })[currentState] || currentState));

      const facts = element('div', 'profile-facts');
      const factValues = [
        ['浏览器', profileEngine(profile)],
        ['任务行为', ({ human: '深度拟人', adaptive: '自适应', fast: '快速' })[profileMode(profile)]],
        ['最近使用', formatTime(profile.lastUsedAt, { relative: true })]
      ];
      for (const [label, value] of factValues) {
        const fact = element('div');
        fact.append(element('span', '', label), element('strong', '', value));
        facts.append(fact);
      }

      const settings = element('div', 'profile-settings');
      const modeLabel = element('label');
      modeLabel.append(element('span', '', '任务行为'));
      const mode = element('select', 'npc-field compact-field');
      for (const value of ['fast', 'adaptive', 'human']) {
        const option = element('option', '', ({ fast: '快速', adaptive: '自适应', human: '深度拟人' })[value]);
        option.value = value;
        mode.append(option);
      }
      mode.value = profileMode(profile);
      mode.disabled = persistent || isPending(`profile:${id}`);
      mode.title = persistent ? '持久 Profile 固定使用深度拟人行为' : '临时 Profile 的任务行为';
      focusKey(mode, `profile:${id}:mode`);
      mode.addEventListener('change', () => updateProfile(profile, { defaultBehavior: mode.value }));
      modeLabel.append(mode);

      const headlessLabel = element('label', 'switch-field');
      const headless = element('input');
      headless.type = 'checkbox';
      headless.checked = Boolean(profile.headless);
      headless.disabled = isPending(`profile:${id}`);
      focusKey(headless, `profile:${id}:headless`);
      headless.addEventListener('change', () => updateProfile(profile, { headless: headless.checked }));
      headlessLabel.append(headless, element('span', '', '任务后台运行'));
      settings.append(modeLabel, headlessLabel);

      const footer = element('div', 'profile-actions');
      const rename = button('改名', 'npc-btn-ghost compact-button', () => renameProfile(profile));
      const toggle = button(busy ? '关闭窗口' : '打开登录窗口', 'npc-btn-secondary compact-button', () => setProfileOpen(profile, !busy));
      toggle.disabled = !persistent || isPending(`profile:${id}`);
      toggle.title = persistent ? '打开独立可见 Chrome 窗口进行人工登录或检查' : '临时 Profile 只在任务中启动';
      const remove = button('删除', 'npc-btn-danger compact-button', () => deleteProfile(profile));
      remove.disabled = busy || isPending(`profile:${id}`);
      focusKey(rename, `profile:${id}:rename`);
      focusKey(toggle, `profile:${id}:toggle`);
      focusKey(remove, `profile:${id}:delete`);
      footer.append(rename, toggle, remove);
      card.append(heading, facts, settings, footer);
      ui.profiles.append(card);
    }
  }, force);
  setInlineError(ui.profilesError, state.mutationErrors.profiles || state.sectionErrors.profiles || '');
}

function syncTaskAgentFilter() {
  const selected = ui.taskAgentFilter.value;
  const sources = new Map();
  for (const agent of state.agents) sources.set(agentId(agent), agentName(agent));
  for (const task of state.tasks) {
    const agent = taskAgent(task);
    if (agent.id) sources.set(agent.id, agent.name);
  }
  const nextSignature = JSON.stringify([...sources]);
  if (state.renderSignatures.get('agent-filter') === nextSignature) return;
  ui.taskAgentFilter.replaceChildren(element('option', '', '全部 Agent'));
  ui.taskAgentFilter.firstChild.value = '';
  for (const [id, name] of sources) {
    const option = element('option', '', name);
    option.value = id;
    ui.taskAgentFilter.append(option);
  }
  ui.taskAgentFilter.value = sources.has(selected) ? selected : '';
  state.renderSignatures.set('agent-filter', nextSignature);
}

function renderTasks(force = false) {
  syncTaskAgentFilter();
  const filtered = state.tasks.filter(taskMatchesFilter);
  renderWhenChanged('tasks', { filtered, search: ui.taskSearch.value, agent: ui.taskAgentFilter.value, state: ui.taskStateFilter.value }, ui.tasks, () => {
    ui.tasks.replaceChildren();
    if (!filtered.length) {
      ui.tasks.append(element('p', 'empty-state', state.tasks.length ? '没有符合当前筛选条件的任务。' : '当前还没有任务。'));
      return;
    }
    for (const task of filtered) {
      const status = taskState(task);
      const progress = taskProgress(task);
      const activity = taskActivity(task);
      const agent = taskAgent(task);
      const card = element('article', `task-card task-${status}`);
      card.dataset.taskId = task.id;
      const main = element('div', 'task-main');
      const heading = element('div', 'task-card-heading');
      const open = button(taskTitle(task), 'task-title-button', () => openTaskDetail(task.id));
      const subtitle = element('p', 'task-subtitle', reportSummary(task));
      const titleGroup = element('div');
      titleGroup.append(open, subtitle);
      heading.append(titleGroup, element('span', `npc-chip task-state-chip task-state-${status}`, taskStateLabel(task)));

      const meta = element('div', 'task-meta-row');
      meta.append(
        labelledValue('Agent', agent.name),
        labelledValue('Profile', task.profileName || task.profileId || '—'),
        labelledValue('当前阶段', activity.label),
        labelledValue('最近反馈', formatTime(activity.updatedAt, { relative: true }))
      );

      const progressRow = element('div', 'task-progress-row');
      const track = element('div', 'progress-track');
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', `${taskTitle(task)}进度`);
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      if (progress.percent !== null) track.setAttribute('aria-valuenow', String(progress.percent));
      else track.setAttribute('aria-valuetext', '正在执行，尚无总量');
      const bar = element('span', 'progress-bar');
      bar.style.width = `${progress.percent ?? 4}%`;
      track.append(bar);
      progressRow.append(
        track,
        element('span', 'npc-number', progress.percent === null ? '进行中' : `${progress.percent}%`)
      );
      main.append(heading, meta, progressRow);

      const side = element('div', 'task-side');
      side.append(
        element('span', 'task-id', task.id),
        button('打开任务', 'npc-btn-secondary compact-button', () => openTaskDetail(task.id))
      );
      card.append(main, side);
      ui.tasks.append(card);
    }
  }, force);
  setInlineError(ui.tasksError, state.sectionErrors.tasks || '');
}

function labelledValue(label, value) {
  const group = element('span', 'labelled-value');
  group.append(element('small', '', label), element('strong', '', value));
  return group;
}

function renderAll(force = false) {
  const activeFocusKey = document.activeElement?.dataset?.focusKey || state.pendingFocusKey || '';
  renderSummary();
  renderOverview(force);
  renderAgents(force);
  renderProfiles(force);
  renderTasks(force);
  if (activeFocusKey) {
    state.pendingFocusKey = restoreFocus(activeFocusKey) ? '' : activeFocusKey;
  }
}

function applyRefreshResult(key, result) {
  if (result.status === 'fulfilled') {
    state.sectionErrors[key] = '';
    if (key === 'summary') state.summary = recordFrom(result.value, 'summary');
    if (key === 'agents') state.agents = listFrom(result.value, 'agents');
    if (key === 'profiles') state.profiles = listFrom(result.value, 'profiles');
    if (key === 'tasks') state.tasks = listFrom(result.value, 'tasks');
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
      request('/v1/dashboard/summary'),
      request('/v1/agents'),
      request('/v1/profiles'),
      request('/v1/tasks')
    ]);
    if (sequence !== state.refreshSequence) return;
    const keys = ['summary', 'agents', 'profiles', 'tasks'];
    const successCount = results.reduce((count, result, index) => count + Number(applyRefreshResult(keys[index], result)), 0);
    const unauthorized = results.some((result) => result.status === 'rejected' && result.reason?.status === 401);
    const connectivityFailure = results.every((result) => (
      result.status === 'rejected' && (result.reason?.status === 0 || result.reason?.status >= 500)
    ));

    if (unauthorized) markAuthorizationRequired();
    else if (successCount > 0) markConnected();
    else if (connectivityFailure) markStale();

    if (successCount > 0) {
      const now = new Date();
      ui.lastRefresh.textContent = `刷新于 ${formatTime(now)}`;
    }
    renderAll(force);
    if (state.selectedTaskId && ui.taskDialog.open && !containsInteractiveFocus(ui.commandPanel)) {
      void refreshTaskDetail({ background: true });
    }
    openInitialTaskIfNeeded();
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
  const live = state.tasks.some((task) => ACTIVE_TASK_STATES.has(taskState(task)) || taskState(task) === 'waiting_user');
  return live ? 2_000 : 6_000;
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  if (state.stopped) return;
  state.refreshTimer = setTimeout(async () => {
    await refreshAll();
    scheduleRefresh();
  }, pollingDelay());
}

function openInitialTaskIfNeeded() {
  if (state.openedInitialTask) return;
  const id = new URL(location.href).searchParams.get('task');
  if (!id) return;
  state.openedInitialTask = true;
  setView('tasks', { updateHistory: false, focus: false });
  void openTaskDetail(id, { updateHistory: false });
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
  ui.profileMode.value = persistent ? 'human' : 'adaptive';
  ui.profileEngine.disabled = persistent;
  ui.profileMode.disabled = persistent;
  ui.profileEngine.title = persistent ? '持久 Profile 固定使用本机稳定版 Chrome' : '临时 Profile 使用项目锁定 Chromium';
  ui.profileMode.title = persistent ? '持久 Profile 固定使用深度拟人行为' : '选择临时 Profile 的任务行为';
}

function beginMutation(key) {
  state.pendingMutations.add(key);
  renderAll(true);
}

function endMutation(key) {
  state.pendingMutations.delete(key);
}

function isPending(key) {
  return state.pendingMutations.has(key);
}

async function runMutation(key, operation, successMessage) {
  if (isPending(key)) return null;
  const activeFocusKey = document.activeElement?.dataset?.focusKey || '';
  const focusIntentSequence = ++state.focusIntentSequence;
  state.pendingFocusKey = activeFocusKey;
  beginMutation(key);
  try {
    const result = await operation();
    const section = mutationSection(key);
    if (section) state.mutationErrors[section] = '';
    if (key.startsWith('task:')) setInlineError(ui.taskDetailError);
    if (successMessage) setToast(successMessage, 'success');
    return result;
  } catch (error) {
    if (error.status === 403) {
      const message = `没有权限执行这项操作：${error.message}`;
      if (key.startsWith('task:')) setInlineError(ui.taskDetailError, message);
      else {
        const section = mutationSection(key);
        if (section) state.mutationErrors[section] = message;
      }
      setToast(message, 'error');
    } else if (error.status === 409) {
      const message = error.code === 'PROFILE_NAME_EXISTS'
        ? 'Profile 名称已存在，请换一个名称。'
        : error.code === 'TASK_REVISION_CONFLICT'
          ? '状态已变化，已刷新最新状态。请确认后重试。'
          : error.message || '当前状态不允许这项操作，请刷新后重试。';
      if (key.startsWith('task:')) setInlineError(ui.taskDetailError, message);
      else {
        const section = mutationSection(key);
        if (section) state.mutationErrors[section] = message;
      }
      setToast(message, 'error');
    } else if (error.status !== 401) {
      setToast(error.message || '操作失败', 'error');
    }
    return null;
  } finally {
    endMutation(key);
    await refreshAll({ force: true });
    if (
      focusIntentSequence === state.focusIntentSequence &&
      state.pendingFocusKey === activeFocusKey &&
      activeFocusKey && restoreFocus(activeFocusKey)
    ) state.pendingFocusKey = '';
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
  }), 'Profile 已创建并加入全局资源池');
  if (result) {
    ui.createProfileForm.reset();
    syncCreatePolicy();
    profileCreateVisible(false);
  }
}

async function updateProfile(profile, patch) {
  const key = `profile:${profile.id}`;
  await runMutation(key, () => request(`/v1/profiles/${encodeURIComponent(profile.id)}`, {
    method: 'PATCH', body: patch
  }), 'Profile 设置已保存');
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
  const description = profile.kind === 'ephemeral' ? '临时任务设置' : '持久浏览器数据';
  if (!confirm(`确定删除 Profile“${profile.name || profile.id}”及其${description}？此操作无法撤销。`)) return;
  await runMutation(`profile:${profile.id}`, () => request(`/v1/profiles/${encodeURIComponent(profile.id)}`, {
    method: 'DELETE'
  }), 'Profile 已删除');
}

async function setAgentAccess(agent) {
  const id = agentId(agent);
  const restoring = agentStatus(agent) === 'revoked';
  if (!id || isPending(`agent:${id}`) || isAgentActionLocked(id)) return;
  const question = restoring
    ? `恢复“${agentName(agent)}”接入 Manager 的权限？新的请求将重新建立在线状态。`
    : `撤销“${agentName(agent)}”接入 Manager 的权限？历史任务和报告会保留。`;
  if (!confirm(question)) return;
  const action = restoring ? 'restore' : 'revoke';
  const unlockAt = Date.now() + 1_000;
  state.agentActionLocks.set(id, unlockAt);
  try {
    await runMutation(`agent:${id}`, () => request(`/v1/agents/${encodeURIComponent(id)}/actions`, {
      method: 'POST', body: { action }
    }), restoring ? 'Agent 接入已恢复；下次请求会重新建立在线状态' : 'Agent 接入已撤销');
  } finally {
    setTimeout(() => {
      if ((state.agentActionLocks.get(id) ?? 0) <= Date.now()) {
        state.agentActionLocks.delete(id);
        renderAgents(true);
      }
    }, Math.max(0, unlockAt - Date.now()) + 20);
  }
}

function updateTaskUrl(id) {
  const url = new URL(location.href);
  url.searchParams.set('view', 'tasks');
  if (id) url.searchParams.set('task', id);
  else url.searchParams.delete('task');
  history.pushState(null, '', `${url.pathname}${url.search}`);
}

async function openTaskDetail(id, { updateHistory = true } = {}) {
  if (!id) return;
  state.returnFocus = document.activeElement;
  setInlineError(ui.taskDetailError);
  state.selectedTaskId = id;
  state.selectedTask = state.tasks.find((task) => task.id === id) || null;
  state.selectedArtifacts = [];
  ui.taskDetailTitle.textContent = state.selectedTask ? taskTitle(state.selectedTask) : '任务详情';
  ui.taskDetailLoading.classList.remove('hidden');
  ui.taskDetailContent.classList.add('hidden');
  if (!ui.taskDialog.open) ui.taskDialog.showModal();
  if (updateHistory) updateTaskUrl(id);
  await refreshTaskDetail();
}

async function refreshTaskDetail({ background = false } = {}) {
  const id = state.selectedTaskId;
  if (!id) return;
  const sequence = ++state.detailSequence;
  if (!background) ui.taskDetailLoading.classList.remove('hidden');
  const [taskResult, artifactResult] = await Promise.allSettled([
    request(`/v1/tasks/${encodeURIComponent(id)}`),
    request(`/v1/tasks/${encodeURIComponent(id)}/artifacts`)
  ]);
  if (sequence !== state.detailSequence || id !== state.selectedTaskId) return;

  if (taskResult.status === 'fulfilled') {
    state.selectedTask = recordFrom(taskResult.value, 'task');
  } else if (taskResult.reason?.status === 403) {
    setInlineError(ui.taskDetailError, `没有权限读取这个任务：${taskResult.reason.message}`);
  } else if (!state.selectedTask && taskResult.reason?.status !== 401) {
    setToast(taskResult.reason?.message || '无法读取任务详情', 'error');
  }
  if (artifactResult.status === 'fulfilled') {
    state.selectedArtifacts = listFrom(artifactResult.value, 'artifacts');
  }
  if (state.selectedTask) renderTaskDetail();
  ui.taskDetailLoading.classList.toggle('hidden', Boolean(state.selectedTask));
  ui.taskDetailContent.classList.toggle('hidden', !state.selectedTask);
}

function closeTaskDetail({ updateHistory = true } = {}) {
  state.detailSequence += 1;
  state.selectedTaskId = '';
  state.selectedTask = null;
  state.selectedArtifacts = [];
  if (ui.taskDialog.open) ui.taskDialog.close();
  if (updateHistory) {
    const url = new URL(location.href);
    url.searchParams.delete('task');
    history.pushState(null, '', `${url.pathname}${url.search}`);
  }
  if (state.returnFocus?.isConnected) state.returnFocus.focus();
}

function renderTaskDetail() {
  const task = state.selectedTask;
  if (!task) return;
  const status = taskState(task);
  const agent = taskAgent(task);
  const activity = taskActivity(task);
  const progress = taskProgress(task);

  ui.taskDetailTitle.textContent = taskTitle(task);
  ui.taskDetailMeta.replaceChildren(
    element('span', `npc-chip task-state-chip task-state-${status}`, taskStateLabel(task)),
    element('span', '', `Agent · ${agent.name}`),
    element('span', '', `Profile · ${task.profileName || task.profileId || '—'}`),
    element('span', 'task-id', task.id)
  );
  ui.detailActivity.textContent = activity.label;
  ui.detailProgressCopy.textContent = progress.percent === null ? '进行中' : `${progress.percent}%`;
  ui.detailProgressBar.style.width = `${progress.percent ?? 4}%`;
  ui.detailProgressTrack.setAttribute('aria-valuemin', '0');
  ui.detailProgressTrack.setAttribute('aria-valuemax', '100');
  if (progress.percent === null) {
    ui.detailProgressTrack.removeAttribute('aria-valuenow');
    ui.detailProgressTrack.setAttribute('aria-valuetext', '正在执行，尚无总量');
  } else {
    ui.detailProgressTrack.setAttribute('aria-valuenow', String(progress.percent));
    ui.detailProgressTrack.removeAttribute('aria-valuetext');
  }
  ui.detailProgressMessage.textContent = progress.message || `最近反馈于 ${formatTime(activity.updatedAt, { relative: true })}`;

  const pending = isPending(`task:${task.id}`);
  const ending = ['cancel_requested', 'cancelling'].includes(status);
  const validRevision = Number.isSafeInteger(task.revision) && task.revision > 0;
  ui.taskPause.disabled = pending || !validRevision || !ACTIVE_TASK_STATES.has(status) || ['queued', 'pause_requested'].includes(status) || ending;
  ui.taskResume.disabled = pending || !validRevision || !['paused', 'pause_requested', 'waiting_user'].includes(status);
  ui.taskResume.textContent = status === 'waiting_user' ? '提供指令' : status === 'pause_requested' ? '撤销暂停' : '继续';
  ui.taskTerminate.disabled = pending || !validRevision || TERMINAL_TASK_STATES.has(status) || ending;
  ui.taskModify.disabled = pending || !validRevision || TERMINAL_TASK_STATES.has(status) || ending;
  ui.taskAsk.disabled = pending || !validRevision || ending;

  ui.commandTarget.textContent = agent.name;
  renderTaskReport(task);
  renderTimeline(task);
  renderArtifacts();
  renderDiagnostics(task);
}

function renderTaskReport(task) {
  const report = reportData(task);
  ui.taskReport.replaceChildren();
  if (!report.exists) {
    const stateValue = taskState(task);
    const copy = stateValue === 'completed'
      ? '浏览器执行已完成，正在等待 Agent 整理并发布最终报告。'
      : TERMINAL_TASK_STATES.has(stateValue)
        ? '该任务没有可发布的最终报告。请查看时间线了解原因。'
        : '任务仍在执行。Agent 最终报告会在验收完成后显示在这里。';
    ui.taskReport.append(element('div', 'report-empty', copy));
    ui.reportStatus.className = `npc-chip ${stateValue === 'completed' ? 'npc-chip-warning' : 'npc-chip-info'}`;
    ui.reportStatus.textContent = stateValue === 'completed' ? '等待 Agent 发布' : '任务进行中';
    return;
  }
  ui.reportStatus.className = 'npc-chip npc-chip-success';
  ui.reportStatus.textContent = report.publishedAt ? `发布于 ${formatTime(report.publishedAt, { relative: true })}` : '已发布';
  if (report.summary) ui.taskReport.append(element('p', 'executive-summary', report.summary));
  renderMetrics(ui.taskReport, report.metrics);
  if (report.highlights.length) renderReportList(ui.taskReport, '关键发现', report.highlights, 'highlight-list');
  if (report.markdown) renderMarkdown(ui.taskReport, report.markdown);
  for (const section of report.sections) {
    const wrapper = element('section', 'report-section');
    if (section.heading) wrapper.append(element('h3', '', section.heading));
    if (section.body) renderMarkdown(wrapper, String(section.body));
    ui.taskReport.append(wrapper);
  }
  if (report.caveats.length) renderReportList(ui.taskReport, '限制与说明', report.caveats, 'caveat-list');
}

function renderMetrics(container, metrics) {
  if (!metrics) return;
  const entries = Array.isArray(metrics)
    ? metrics.map((item, index) => [item?.label || item?.name || `指标 ${index + 1}`, item?.value ?? item])
    : Object.entries(metrics);
  if (!entries.length) return;
  const grid = element('dl', 'report-metrics');
  for (const [label, value] of entries.slice(0, 12)) {
    const item = element('div');
    item.append(element('dt', '', label), element('dd', 'npc-number', typeof value === 'object' ? value?.value ?? '—' : value));
    grid.append(item);
  }
  container.append(grid);
}

function renderReportList(container, title, values, className) {
  const section = element('section', `report-list ${className}`);
  section.append(element('h3', '', title));
  const list = element('ul');
  for (const value of values) {
    const text = typeof value === 'object' ? value.text || value.label || value.value : value;
    if (text !== undefined) list.append(element('li', '', text));
  }
  section.append(list);
  container.append(section);
}

function appendInlineMarkdown(container, text) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) container.append(document.createTextNode(text.slice(offset, match.index)));
    const token = match[0];
    if (token.startsWith('**')) container.append(element('strong', '', token.slice(2, -2)));
    else if (token.startsWith('`')) container.append(element('code', '', token.slice(1, -1)));
    else {
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
      if (linkMatch) {
        const link = element('a', '', linkMatch[1]);
        link.href = linkMatch[2];
        link.target = '_blank';
        link.rel = 'noreferrer';
        container.append(link);
      }
    }
    offset = match.index + token.length;
  }
  if (offset < text.length) container.append(document.createTextNode(text.slice(offset)));
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function renderMarkdown(container, markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  let codeBlock = null;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().startsWith('```')) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) codeLines.push(lines[index++]);
      const details = element('details', 'report-technical');
      details.append(element('summary', '', '报告技术附录'), element('pre', '', codeLines.join('\n')));
      codeBlock = details;
      container.append(codeBlock);
      index += 1;
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      const table = element('table', 'report-table');
      const head = element('thead');
      const headRow = element('tr');
      for (const cell of splitTableRow(line)) headRow.append(element('th', '', cell));
      head.append(headRow);
      const body = element('tbody');
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const row = element('tr');
        for (const cell of splitTableRow(lines[index])) row.append(element('td', '', cell));
        body.append(row);
        index += 1;
      }
      table.append(head, body);
      const wrap = element('div', 'report-table-wrap');
      wrap.append(table);
      container.append(wrap);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const node = element(`h${Math.min(4, heading[1].length + 1)}`);
      appendInlineMarkdown(node, heading[2]);
      container.append(node);
      index += 1;
      continue;
    }
    const listMatch = /^\s*([-*]|\d+\.)\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1]);
      const list = element(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const itemMatch = /^\s*([-*]|\d+\.)\s+(.+)$/.exec(lines[index]);
        if (!itemMatch || /\d+\./.test(itemMatch[1]) !== ordered) break;
        const item = element('li');
        appendInlineMarkdown(item, itemMatch[2]);
        list.append(item);
        index += 1;
      }
      container.append(list);
      continue;
    }
    if (line.trim().startsWith('>')) {
      const quote = element('blockquote');
      appendInlineMarkdown(quote, line.trim().replace(/^>\s?/, ''));
      container.append(quote);
      index += 1;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraphLines = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s+|^\s*([-*]|\d+\.)\s+|^>|^```/.test(lines[index])) {
      if (lines[index].includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) break;
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    const paragraph = element('p');
    appendInlineMarkdown(paragraph, paragraphLines.join(' '));
    container.append(paragraph);
  }
}

function normalizeTimeline(task) {
  const source = task.timeline || task.events || task.activityLog || [];
  const entries = Array.isArray(source) ? source.map((entry) => ({
    id: entry.id || entry.eventId || '',
    kind: entry.kind || entry.type || 'event',
    title: entry.title || entry.label || entry.phase || entry.kind || entry.type || '任务更新',
    message: entry.message || entry.text || entry.detail || '',
    status: entry.status || '',
    at: entry.at || entry.createdAt || entry.updatedAt || ''
  })) : [];
  if (!entries.length) {
    if (task.createdAt) entries.push({ kind: 'created', title: '任务已创建', message: `由 ${taskAgent(task).name} 发起`, at: task.createdAt });
    if (task.startedAt) entries.push({ kind: 'started', title: '浏览器任务已开始', message: taskActivity(task).label, at: task.startedAt });
    if (task.progress?.updatedAt || task.progressAt) entries.push({ kind: 'progress', title: taskActivity(task).label, message: taskProgress(task).message, at: task.progress?.updatedAt || task.progressAt });
    if (task.userRequest?.requestedAt) entries.push({ kind: 'attention', title: '等待人类指令', message: task.userRequest.reason || task.userRequest.instructions || '', at: task.userRequest.requestedAt });
    if (task.finishedAt) entries.push({ kind: taskState(task), title: taskStateLabel(task), message: reportSummary(task), at: task.finishedAt });
  }
  return entries.sort((left, right) => Date.parse(right.at || 0) - Date.parse(left.at || 0)).slice(0, 50);
}

function renderTimeline(task) {
  const entries = normalizeTimeline(task);
  ui.taskTimeline.replaceChildren();
  if (!entries.length) {
    ui.taskTimeline.append(element('li', 'empty-state', '尚无任务事件。'));
    return;
  }
  for (const entry of entries) {
    const item = element('li', `timeline-item timeline-${entry.kind}`);
    const copy = element('div');
    copy.append(element('strong', '', entry.title), element('p', '', entry.message || '状态已更新'));
    item.append(copy, element('time', '', formatTime(entry.at, { relative: true })));
    ui.taskTimeline.append(item);
  }
}

function safeArtifactUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value, location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function renderArtifacts() {
  ui.taskArtifacts.replaceChildren();
  if (!state.selectedArtifacts.length) {
    ui.taskArtifacts.append(element('p', 'empty-state', '当前没有已声明的交付文件。'));
    return;
  }
  for (const artifact of state.selectedArtifacts) {
    const item = element('article', 'artifact-item');
    const copy = element('div');
    copy.append(
      element('strong', '', artifact.name || artifact.label || artifact.id || '交付文件'),
      element('small', '', [artifact.mimeType || artifact.kind, formatBytes(artifact.sizeBytes)].filter(Boolean).join(' · '))
    );
    item.append(copy);
    const url = safeArtifactUrl(artifact.downloadUrl || artifact.url || artifact.href);
    if (url) {
      const link = element('a', 'npc-btn npc-btn-secondary compact-button', '打开');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      item.append(link);
    }
    ui.taskArtifacts.append(item);
  }
}

function renderDiagnostics(task) {
  const bounded = {
    id: task.id,
    revision: task.revision,
    state: taskState(task),
    agent: taskAgent(task),
    profileId: task.profileId,
    currentActivity: task.currentActivity,
    progress: task.progress,
    health: task.health,
    heartbeatAt: task.heartbeatAt,
    progressAt: task.progressAt,
    cooldown: task.cooldown,
    checkpoint: task.checkpoint,
    cleanup: task.cleanup,
    error: task.error,
    diagnostic: task.diagnostic,
    observation: task.observation
  };
  ui.developerDiagnostics.textContent = JSON.stringify(bounded, null, 2);
}

function commandId() {
  if (crypto.randomUUID) return `cmd_${crypto.randomUUID()}`;
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function applyTaskMutationResult(payload) {
  const task = recordFrom(payload, 'task');
  if (!task?.id) return;
  const index = state.tasks.findIndex((candidate) => candidate.id === task.id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.unshift(task);
  if (state.selectedTaskId === task.id) {
    state.selectedTask = task;
    renderTaskDetail();
  }
}

function prepareCommand(kind) {
  if (!state.selectedTask) return;
  ui.commandKind.value = kind;
  const modifying = kind === 'modify';
  const continuing = kind === 'continue';
  ui.commandTitle.textContent = continuing ? '回复任务请求' : modifying ? '修改任务目标' : '询问任务 Agent';
  ui.commandText.placeholder = continuing
    ? '输入 Agent 当前等待的决定或下一步指令。'
    : modifying
    ? '说明需要增加、删除或调整的任务目标。Agent 会在安全检查点确认如何应用。'
    : '询问当前进度、阻塞原因、结果范围或下一步计划。';
  ui.commandHelp.textContent = continuing
    ? '回复会继续同一个 Worker、浏览器、检查点和任务 ID。'
    : modifying
    ? '运行中的任务不会被直接篡改；这条修改会作为带版本的指令交给 Agent 处理。'
    : '消息会持久保存；Agent 离线时将在下次接入后送达。';
  ui.sendCommand.textContent = continuing ? '回复并继续任务' : modifying ? '发送修改要求' : '发送给 Agent';
  ui.commandPanel.scrollIntoView({ block: 'center', behavior: 'smooth' });
  ui.commandText.focus();
}

async function submitTaskCommand(event) {
  event.preventDefault();
  const task = state.selectedTask;
  const text = ui.commandText.value.trim();
  if (!task || !text) return;
  const kind = ['modify', 'continue'].includes(ui.commandKind.value) ? ui.commandKind.value : 'ask';
  if (!Number.isSafeInteger(task.revision) || task.revision < 1) {
    setToast('任务版本尚未就绪，正在刷新最新状态', 'error');
    await refreshTaskDetail();
    return;
  }
  const key = `task:${task.id}:${kind}`;
  const result = await runMutation(key, () => kind === 'continue'
    ? request(`/v1/tasks/${encodeURIComponent(task.id)}/continue`, {
      method: 'POST',
      body: {
        ...(task.userRequest?.id ? { requestId: task.userRequest.id } : {}),
        note: text
      }
    })
    : request(`/v1/tasks/${encodeURIComponent(task.id)}/commands`, {
      method: 'POST',
      body: {
        kind,
        text,
        commandId: commandId(),
        expectedRevision: task.revision ?? 0
      }
    }), kind === 'continue'
      ? '指令已送达，任务将在原浏览器中继续'
      : kind === 'modify'
        ? '修改要求已保存并发送给 Agent'
        : '问题已保存并发送给 Agent');
  if (result) {
    applyTaskMutationResult(result);
    ui.commandText.value = '';
    await refreshTaskDetail();
  }
}

async function sendTaskAction(action) {
  const task = state.selectedTask;
  if (!task) return;
  if (action === 'terminate' && !confirm(`确定终止任务“${taskTitle(task)}”？Manager 会关闭任务窗口并释放 Profile。`)) return;
  if (!Number.isSafeInteger(task.revision) || task.revision < 1) {
    setToast('任务版本尚未就绪，正在刷新最新状态', 'error');
    await refreshTaskDetail();
    return;
  }
  const labels = { pause: '暂停请求已发送', resume: '继续请求已发送', terminate: '终止请求已发送' };
  const result = await runMutation(`task:${task.id}`, () => request(`/v1/tasks/${encodeURIComponent(task.id)}/actions`, {
    method: 'POST',
    body: {
      action,
      commandId: commandId(),
      expectedRevision: task.revision
    }
  }), labels[action]);
  if (result) applyTaskMutationResult(result);
  await refreshTaskDetail();
}

async function logout() {
  if (!confirm('退出这台浏览器的 Owner Console 会话？任务不会停止。')) return;
  try {
    await request('/v1/dashboard/logout', { method: 'POST' });
    markAuthorizationRequired();
    setToast('已退出 Owner Console；后台任务仍在继续', 'success');
  } catch (error) {
    if (error.status !== 401) setToast(error.message || '退出失败', 'error');
  }
}

for (const link of ui.navLinks) link.addEventListener('click', () => setView(link.dataset.view));
for (const link of ui.openViewLinks) link.addEventListener('click', () => setView(link.dataset.openView));
ui.refreshAll.addEventListener('click', () => void refreshAll({ force: true }));
ui.retryAuth.addEventListener('click', () => void refreshAll({ force: true }));
ui.retryStale.addEventListener('click', () => void refreshAll({ force: true }));
ui.logoutButton.addEventListener('click', () => void logout());
ui.toggleProfileCreate.addEventListener('click', () => profileCreateVisible(true));
ui.closeProfileCreate.addEventListener('click', () => profileCreateVisible(false));
ui.profileKind.addEventListener('change', syncCreatePolicy);
ui.createProfileForm.addEventListener('submit', createProfile);
ui.taskSearch.addEventListener('input', () => renderTasks(true));
ui.taskAgentFilter.addEventListener('change', () => renderTasks(true));
ui.taskStateFilter.addEventListener('change', () => renderTasks(true));
ui.closeTaskDetail.addEventListener('click', closeTaskDetail);
ui.taskDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeTaskDetail();
});
ui.taskPause.addEventListener('click', () => void sendTaskAction('pause'));
ui.taskResume.addEventListener('click', () => {
  if (taskState(state.selectedTask) === 'waiting_user') prepareCommand('continue');
  else void sendTaskAction('resume');
});
ui.taskTerminate.addEventListener('click', () => void sendTaskAction('terminate'));
ui.taskModify.addEventListener('click', () => prepareCommand('modify'));
ui.taskAsk.addEventListener('click', () => prepareCommand('ask'));
ui.taskCommandForm.addEventListener('submit', submitTaskCommand);
document.addEventListener('visibilitychange', scheduleRefresh);
window.addEventListener('popstate', () => {
  const url = new URL(location.href);
  setView(url.searchParams.get('view') || (url.searchParams.has('task') ? 'tasks' : 'overview'), {
    updateHistory: false,
    focus: false
  });
  const taskId = url.searchParams.get('task') || '';
  if (taskId && taskId !== state.selectedTaskId) void openTaskDetail(taskId, { updateHistory: false });
  if (!taskId && ui.taskDialog.open) closeTaskDetail({ updateHistory: false });
});
window.addEventListener('pagehide', () => {
  state.stopped = true;
  clearTimeout(state.refreshTimer);
});
window.addEventListener('pageshow', () => {
  if (!state.stopped) return;
  state.stopped = false;
  void refreshAll({ force: true });
  scheduleRefresh();
});

const initialUrl = new URL(location.href);
setView(initialUrl.searchParams.get('view') || (initialUrl.searchParams.has('task') ? 'tasks' : 'overview'), {
  updateHistory: false,
  focus: false
});
syncCreatePolicy();
void bootstrapOwnerSession()
  .catch((error) => {
    if (error.status !== 401) setToast(error.message || '无法建立 Owner 会话', 'error');
  })
  .then(() => refreshAll({ force: true }))
  .finally(scheduleRefresh);
