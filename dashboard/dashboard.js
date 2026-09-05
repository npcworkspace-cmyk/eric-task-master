const READ_REQUEST_TIMEOUT_MS = 10_000;
const MUTATION_REQUEST_TIMEOUT_MS = 60_000;
const PROFILE_OPEN_REQUEST_TIMEOUT_MS = 100_000;
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
    'cleanup.open': '清理空间',
    'cleanup.safety': '保留登录状态和扩展。运行中、等待中的任务，以及占用或手动打开的 Profiles 会跳过。',
    'cleanup.select': '选择要清理的内容',
    'cleanup.cache': '浏览器缓存',
    'cleanup.cacheNote': '仅清理闲置浏览器的缓存，保留登录数据。',
    'cleanup.temporary': '无用临时脚本和文件',
    'cleanup.temporaryNote': '仅清理 Manager 确认可移除的临时文件。',
    'cleanup.output': '历史截图、下载和结果',
    'cleanup.outputNote': '默认保留；勾选后将永久删除可清理的历史产物。',
    'cleanup.confirmNote': '预览不会删除文件。实际清理会重新检查；删除无法撤销。',
    'cleanup.confirm': '清理所选',
    'cleanup.retry': '重新预览',
    'cleanup.estimating': '正在估算所选空间…',
    'cleanup.estimate': '预计可释放',
    'cleanup.freed': '已清理文件大小',
    'cleanup.files': '{files} 个文件',
    'cleanup.choose': '请至少选择一项，再查看预览。',
    'cleanup.running': '正在清理所选内容…',
    'cleanup.skipped': '已跳过 {count} 项',
    'cleanup.failed': '{count} 项未能清理',
    'cleanup.partial': '部分项目未清理，请查看下方原因。',
    'cleanup.invalid': '清理响应与所选内容不匹配，请重新预览。',
    'cleanup.unconfirmed': '清理结果未确认，请重新预览并核对当前空间后再试。',
    'cleanup.reason.PROFILE_BUSY': 'Profile 正在使用，已保留',
    'cleanup.reason.BROWSER_OPEN': '浏览器手动打开中，已保留',
    'cleanup.reason.BROWSER_USAGE_UNKNOWN': '无法确认浏览器是否闲置，已保留',
    'cleanup.reason.TASK_ACTIVE_OR_CLEANUP_UNCONFIRMED': '任务运行、等待中，或尚未确认进程已关闭',
    'cleanup.reason.MANAGED_DIRECTORY_UNSAFE': '目录安全性未通过检查',
    'cleanup.reason.STAGED_MODULE_NOT_FILE': '暂存脚本不是普通文件',
    'cleanup.reason.INVALID_CLEANUP_PATH': '清理路径无效',
    'cleanup.reason.SYMLINK_OR_JUNCTION': '链接目录或文件已保留',
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
    'tasks.title': '当前任务',
    'tasks.description': '只显示进行中和等待处理的任务，结束后自动从列表移除。',
    'tasks.loading': '正在读取任务…',
    'tasks.empty': '当前没有进行中的任务。',
    'tasks.count': '{count} 个任务',
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
    'state.queued': '排队中',
    'state.stopping': '正在停止',
    'state.waiting': '等待中',
    'state.automaticPaused': '已自动暂停',
    'activity.automaticPaused': '等待验证已满20分钟，系统提醒已停止；浏览器现场保留，可手动恢复或停止任务。',
    'activity.verification': '等待人工验证，系统每30秒提醒；20分钟后自动暂停并停止提醒。',
    'state.finished': '已结束',
    'state.stopped': '已停止',
    'state.error': '发生错误',
    'activity.running': '正在执行任务',
    'activity.queued': '等待空闲资源',
    'activity.stopping': '正在停止任务并释放浏览器',
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
    'profiles.rename': '改名',
    'profiles.renamePrompt': '请输入新的 Profile 名称（最多 80 个字符）',
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
    'error.nameTooLong': 'Profile 名称不能超过 80 个字符。',
    'toast.taskStopped': '任务已停止',
    'toast.taskResumed': '任务已恢复',
    'toast.taskDeleted': '任务已删除',
    'toast.profileCreated': 'Profile 已创建',
    'toast.profileRenamed': 'Profile 已改名',
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
    'cleanup.open': 'Clean up space',
    'cleanup.safety': 'Login state and extensions are preserved. Running or waiting tasks, busy Profiles, and manually opened Profiles are skipped.',
    'cleanup.select': 'Choose what to clean',
    'cleanup.cache': 'Browser cache',
    'cleanup.cacheNote': 'Only clears idle browser caches; login data is kept.',
    'cleanup.temporary': 'Unused temporary scripts and files',
    'cleanup.temporaryNote': 'Only temporary files Manager identifies as safe to remove.',
    'cleanup.output': 'Historical screenshots, downloads, and results',
    'cleanup.outputNote': 'Kept by default. Selecting this permanently deletes eligible historical output.',
    'cleanup.confirmNote': 'Preview deletes nothing. Cleanup checks again before removing files. Deletion cannot be undone.',
    'cleanup.confirm': 'Clean selected',
    'cleanup.retry': 'Preview again',
    'cleanup.estimating': 'Estimating selected space…',
    'cleanup.estimate': 'Estimated space to free',
    'cleanup.freed': 'Deleted file size',
    'cleanup.files': '{files} files',
    'cleanup.choose': 'Select at least one category to preview.',
    'cleanup.running': 'Cleaning selected content…',
    'cleanup.skipped': '{count} items skipped',
    'cleanup.failed': '{count} items could not be cleaned',
    'cleanup.partial': 'Some items were not cleaned. See the reasons below.',
    'cleanup.invalid': 'The cleanup response does not match your selection. Preview again.',
    'cleanup.unconfirmed': 'The cleanup result is unconfirmed. Preview again and check the current space before retrying.',
    'cleanup.reason.PROFILE_BUSY': 'Profile is in use; preserved',
    'cleanup.reason.BROWSER_OPEN': 'Browser is manually open; preserved',
    'cleanup.reason.BROWSER_USAGE_UNKNOWN': 'Cannot confirm the browser is idle; preserved',
    'cleanup.reason.TASK_ACTIVE_OR_CLEANUP_UNCONFIRMED': 'Task is running or waiting, or process shutdown is unconfirmed',
    'cleanup.reason.MANAGED_DIRECTORY_UNSAFE': 'Directory did not pass safety checks',
    'cleanup.reason.STAGED_MODULE_NOT_FILE': 'Staged script is not a regular file',
    'cleanup.reason.INVALID_CLEANUP_PATH': 'Invalid cleanup path',
    'cleanup.reason.SYMLINK_OR_JUNCTION': 'Linked file or directory preserved',
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
    'tasks.title': 'Current tasks',
    'tasks.description': 'Only active and waiting tasks appear here. Ended tasks leave the list automatically.',
    'tasks.loading': 'Loading tasks…',
    'tasks.empty': 'No active tasks.',
    'tasks.count': '{count} tasks',
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
    'state.queued': 'Queued',
    'state.stopping': 'Stopping',
    'state.waiting': 'Waiting',
    'state.automaticPaused': 'Automatically paused',
    'activity.automaticPaused': 'Verification waited 20 minutes. Reminders stopped; the browser is retained for manual resume or stop.',
    'activity.verification': 'Waiting for verification. System reminders repeat every 30 seconds and stop at the 20-minute automatic pause.',
    'state.finished': 'Finished',
    'state.stopped': 'Stopped',
    'state.error': 'Error',
    'activity.running': 'Running the task',
    'activity.queued': 'Waiting for available resources',
    'activity.stopping': 'Stopping the task and releasing its browser',
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
    'profiles.rename': 'Rename',
    'profiles.renamePrompt': 'Enter a new Profile name (up to 80 characters)',
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
    'error.nameTooLong': 'Profile names cannot exceed 80 characters.',
    'toast.taskStopped': 'Task stopped',
    'toast.taskResumed': 'Task resumed',
    'toast.taskDeleted': 'Task deleted',
    'toast.profileCreated': 'Profile created',
    'toast.profileRenamed': 'Profile renamed',
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

const cleanup = {
  sequence: 0, previewRequest: null, preview: null, previewKey: '',
  loading: false, executing: false, result: null, error: ''
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
  message: document.querySelector('#dashboard-message'),
  openCleanup: document.querySelector('#open-cleanup'),
  cleanupDialog: document.querySelector('#cleanup-dialog'),
  closeCleanup: document.querySelector('#close-cleanup'),
  cleanupOptions: document.querySelector('#cleanup-options'),
  cleanupCategories: [...document.querySelectorAll('[name="cleanup-category"]')],
  cleanupSummary: document.querySelector('#cleanup-summary'),
  cleanupError: document.querySelector('#cleanup-error'),
  cleanupDetails: document.querySelector('#cleanup-details'),
  retryCleanup: document.querySelector('#retry-cleanup'),
  confirmCleanup: document.querySelector('#confirm-cleanup')
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
  renderCleanup();
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

async function request(path, { method = 'GET', body, requestTimeoutMs } = {}) {
  const upperMethod = method.toUpperCase();
  const attempts = upperMethod === 'GET' ? 2 : 1;
  const timeoutMs = requestTimeoutMs ?? (upperMethod === 'GET' ? READ_REQUEST_TIMEOUT_MS : MUTATION_REQUEST_TIMEOUT_MS);
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

function cleanupSelection() {
  return ui.cleanupCategories.filter((node) => node.checked).map((node) => node.value);
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${new Intl.NumberFormat(state.language, { maximumFractionDigits: index ? 1 : 0 }).format(bytes / (1024 ** index))} ${units[index]}`;
}

function cleanupResponse(payload, categories, preview) {
  const value = dataFrom(payload);
  const validCount = (number) => Number.isSafeInteger(number) && number >= 0;
  if (value?.ok !== true || value.preview !== preview || !validCount(value.bytes) || !validCount(value.files) ||
      !Array.isArray(value.skipped) || !Array.isArray(value.failed) || !Array.isArray(value.categories) ||
      value.categories.map((category) => category.id).join(',') !== categories.join(',')) {
    throw new Error(t('cleanup.invalid'));
  }
  return value;
}

function renderCleanup() {
  const selectionKey = cleanupSelection().join(',');
  const currentPreview = cleanup.preview && cleanup.previewKey === selectionKey;
  ui.cleanupOptions.disabled = cleanup.executing;
  ui.closeCleanup.disabled = cleanup.executing;
  ui.confirmCleanup.disabled = cleanup.executing || cleanup.loading || !currentPreview || !selectionKey;
  ui.confirmCleanup.textContent = t(cleanup.executing ? 'cleanup.running' : 'cleanup.confirm');
  ui.retryCleanup.classList.toggle('hidden', !cleanup.error && !cleanup.result);
  ui.retryCleanup.disabled = cleanup.loading || cleanup.executing;
  ui.cleanupSummary.setAttribute('aria-busy', String(cleanup.loading || cleanup.executing));
  setInlineError(ui.cleanupError, cleanup.error);
  ui.cleanupSummary.replaceChildren();
  ui.cleanupDetails.replaceChildren();
  const report = cleanup.result || (currentPreview ? cleanup.preview : null);
  if (cleanup.executing || cleanup.loading || !report) {
    ui.cleanupSummary.append(element('p', '', t(cleanup.executing ? 'cleanup.running'
      : cleanup.loading ? 'cleanup.estimating' : 'cleanup.choose')));
  } else {
    ui.cleanupSummary.append(
      element('small', '', t(cleanup.result ? 'cleanup.freed' : 'cleanup.estimate')),
      element('strong', 'npc-number', formatBytes(report.bytes)),
      element('small', '', t('cleanup.files', { files: report.files }))
    );
    if (cleanup.result && report.failed.length) ui.cleanupSummary.append(element('p', '', t('cleanup.partial')));
    for (const kind of ['skipped', 'failed']) {
      if (!report[kind].length) continue;
      const section = element('section', `cleanup-${kind}`);
      const list = element('ul');
      section.append(element('h3', '', t(`cleanup.${kind}`, { count: report[kind].length })), list);
      for (const item of report[kind]) {
        const reasonKey = `cleanup.reason.${item.reason}`;
        const reason = I18N.en[reasonKey] ? t(reasonKey) : item.reason || '—';
        list.append(element('li', '', `${item.name || item.id || item.kind || '—'}${item.path ? ` · ${item.path}` : ''} · ${reason}`));
      }
      ui.cleanupDetails.append(section);
    }
  }
}

async function previewCleanup() {
  if (cleanup.executing) return;
  const sequence = ++cleanup.sequence;
  const categories = cleanupSelection();
  cleanup.preview = null;
  cleanup.previewKey = '';
  cleanup.result = null;
  cleanup.error = '';
  cleanup.loading = categories.length > 0;
  renderCleanup();
  if (!categories.length) return;
  // Serialize previews: a rapid selection change must not race Manager's cleanup lock.
  await cleanup.previewRequest?.catch(() => {});
  if (!ui.cleanupDialog.open || sequence !== cleanup.sequence) return;
  const operation = request('/v1/cleanup', { method: 'POST', body: { categories, preview: true } });
  cleanup.previewRequest = operation;
  try {
    const result = cleanupResponse(await operation, categories, true);
    if (!ui.cleanupDialog.open || sequence !== cleanup.sequence) return;
    cleanup.preview = result;
    cleanup.previewKey = categories.join(',');
  } catch (error) {
    if (sequence === cleanup.sequence) cleanup.error = error.message || t('error.read');
  } finally {
    if (cleanup.previewRequest === operation) cleanup.previewRequest = null;
    if (sequence === cleanup.sequence) {
      cleanup.loading = false;
      renderCleanup();
    }
  }
}

function openCleanup() {
  if (ui.cleanupDialog.open) return;
  for (const node of ui.cleanupCategories) node.checked = node.defaultChecked;
  ui.cleanupDialog.showModal();
  void previewCleanup();
}

async function executeCleanup() {
  const categories = cleanupSelection();
  if (cleanup.executing || cleanup.loading || !cleanup.preview || !categories.length ||
      cleanup.previewKey !== categories.join(',')) return;
  cleanup.executing = true;
  cleanup.preview = null;
  cleanup.error = '';
  renderCleanup();
  try {
    const result = await request('/v1/cleanup', { method: 'POST', body: { categories, preview: false } });
    cleanup.result = cleanupResponse(result, categories, false);
  } catch (error) {
    cleanup.error = `${t('cleanup.unconfirmed')} ${error.message || t('error.operation')}`;
  } finally {
    cleanup.executing = false;
    renderCleanup();
  }
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
  if (value === 'queued') return 'queued';
  if (value === 'stopping') return 'stopping';
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
  if (task.state === 'waiting' && task.waiting?.automaticPaused) return t('activity.automaticPaused');
  if (task.state === 'waiting' && task.waiting?.kind === 'verification') return t('activity.verification');
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
  const ordered = state.tasks
    .filter((task) => !TERMINAL_STATES.has(normalizeTaskState(task)))
    .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
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
    heading.append(headingCopy, element('span', `npc-chip task-state-${status}`,
      t(task.state === 'waiting' && task.waiting?.automaticPaused ? 'state.automaticPaused' : `state.${status}`)));

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
  ui.taskCountChip.textContent = t('tasks.count', { count: ordered.length });
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
    card.dataset.profileId = profile.id;

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
    const rename = button(t('profiles.rename'), 'npc-btn-secondary compact-button', () => void renameProfile(profile));
    rename.disabled = pending || status === 'inUse';
    actions.append(rename);
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

async function renameProfile(profile) {
  if (state.pending.has(`profile:${profile.id}`) || profileState(profile) === 'inUse') return;
  const name = prompt(t('profiles.renamePrompt'), profile.name || '')?.trim();
  if (!name || name === profile.name) return;
  if (name.length > 80) {
    setToast(t('error.nameTooLong'), 'error');
    return;
  }
  await runMutation(`profile:${profile.id}`, 'profiles', () => request(`/v1/profiles/${encodeURIComponent(profile.id)}`, {
    method: 'PATCH', body: { name }
  }), t('toast.profileRenamed'));
}

async function setProfileWindow(profile, action) {
  await runMutation(`profile:${profile.id}`, 'profiles', () => request(`/v1/profiles/${encodeURIComponent(profile.id)}/actions`, {
    method: 'POST', body: { action },
    requestTimeoutMs: action === 'open' ? PROFILE_OPEN_REQUEST_TIMEOUT_MS : MUTATION_REQUEST_TIMEOUT_MS
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
ui.openCleanup.addEventListener('click', openCleanup);
ui.closeCleanup.addEventListener('click', () => ui.cleanupDialog.close());
ui.cleanupOptions.addEventListener('change', () => void previewCleanup());
ui.retryCleanup.addEventListener('click', () => void previewCleanup());
ui.confirmCleanup.addEventListener('click', () => void executeCleanup());
ui.cleanupDialog.addEventListener('cancel', (event) => {
  if (cleanup.executing) event.preventDefault();
});
ui.cleanupDialog.addEventListener('close', () => {
  cleanup.sequence += 1;
  cleanup.preview = null;
  cleanup.loading = false;
  ui.openCleanup.focus();
});

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
