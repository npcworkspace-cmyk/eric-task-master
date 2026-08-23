import {
  fetchAndVerifyManagerIdentity,
  trustedManagerFetch,
  verifyPairingManagerIdentity
} from './manager-identity.js';
import { runSessionTransfer } from './session-transfer.js';
import {
  PROFILE_CLOSE_REQUEST_TIMEOUT_MS,
  PROFILE_OPEN_REQUEST_TIMEOUT_MS,
  SESSION_TRANSFER_REQUEST_TIMEOUT_MS
} from './operation-timeouts.js';

const DEFAULT_MANAGER_ORIGIN = 'http://127.0.0.1:19946';
const PROFILE_MODES = ['fast', 'human', 'adaptive'];
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

const ui = Object.freeze({
  connectionDot: document.querySelector('#connection-dot'),
  connectionLabel: document.querySelector('#connection-label'),
  managerOrigin: document.querySelector('#manager-origin'),
  saveOrigin: document.querySelector('#save-origin'),
  discoverManager: document.querySelector('#discover-manager'),
  pairingCode: document.querySelector('#pairing-code'),
  pairExtension: document.querySelector('#pair-extension'),
  workspace: document.querySelector('#workspace'),
  newProfileName: document.querySelector('#new-profile-name'),
  newProfileMode: document.querySelector('#new-profile-mode'),
  newProfileHeadless: document.querySelector('#new-profile-headless'),
  createProfile: document.querySelector('#create-profile'),
  refreshProfiles: document.querySelector('#refresh-profiles'),
  profileList: document.querySelector('#profile-list'),
  sessionCard: document.querySelector('#session-card'),
  currentOrigin: document.querySelector('#current-origin'),
  sessionProfile: document.querySelector('#session-profile'),
  syncSession: document.querySelector('#sync-session'),
  openDashboard: document.querySelector('#open-dashboard'),
  statusMessage: document.querySelector('#status-message')
});

let managerOrigin = DEFAULT_MANAGER_ORIGIN;
let extensionToken = '';
let trustedManagerIdentity = null;
let profiles = [];
let activeSite = null;

function setMessage(message = '', kind = '') {
  ui.statusMessage.textContent = message;
  ui.statusMessage.className = `status-message ${kind}`.trim();
}

function setConnection(status, label) {
  ui.connectionDot.className = `dot ${status}`;
  ui.connectionDot.title = label;
  ui.connectionLabel.textContent = label;
  void chrome.runtime.sendMessage({ type: 'manager-status', status }).catch(() => {});
}

function normalizeLoopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('Manager 必须使用 127.0.0.1 本机地址');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.origin;
}

async function request(path, {
  method = 'GET',
  body,
  authenticated = true,
  timeoutMs = 5000,
  headers: extraHeaders = {}
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = authenticated
      ? await trustedManagerFetch({
        origin: managerOrigin,
        version: EXTENSION_VERSION,
        extensionId: chrome.runtime.id,
        trustedIdentity: trustedManagerIdentity,
        token: extensionToken,
        path,
        method,
        body,
        headers: extraHeaders,
        signal: controller.signal
      })
      : await fetch(new URL(path, managerOrigin), {
        method,
        headers: {
          Accept: 'application/json',
          'X-Taskmaster-Extension-Id': chrome.runtime.id,
          ...extraHeaders,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: controller.signal
      });
    const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.message || payload?.error?.message || `请求失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyTrustedManagerIdentity() {
  if (!trustedManagerIdentity || !extensionToken) throw new Error('请先配对 Manager');
  return fetchAndVerifyManagerIdentity({
    origin: managerOrigin,
    version: EXTENSION_VERSION,
    extensionId: chrome.runtime.id,
    expectedIdentity: trustedManagerIdentity,
    signal: AbortSignal.timeout(5000)
  });
}

function unpackList(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function discover() {
  setConnection('discovering', '正在发现');
  setMessage('');
  try {
    await request('/v1/health', { authenticated: false, timeoutMs: 2500 });
    setConnection(extensionToken ? 'connected' : 'discovering', extensionToken ? '已连接' : '已发现，等待授权码');
    ui.pairExtension.textContent = extensionToken ? '重新配对' : '配对';
    if (extensionToken) {
      await refreshProfiles();
      showWorkspace(true);
    } else {
      showWorkspace(false);
    }
  } catch {
    setConnection('disconnected', 'Manager 未运行');
    showWorkspace(false);
    setMessage('请先让 Agent 启动 Task Master Manager', 'error');
  }
}

async function pair() {
  const enteredCode = ui.pairingCode.value.trim();
  if (!enteredCode) {
    setMessage('请先输入 Agent 显示的一次性配对码', 'error');
    ui.pairingCode.focus();
    return;
  }
  ui.pairExtension.disabled = true;
  setMessage('正在建立本机配对…');
  try {
    const { pairing, identity: verifiedIdentity } = await verifyPairingManagerIdentity({
      pairingCode: enteredCode,
      origin: managerOrigin,
      version: EXTENSION_VERSION,
      extensionId: chrome.runtime.id,
      signal: AbortSignal.timeout(5000)
    });
    const challengePayload = await request('/v1/pair/challenge', {
      authenticated: false,
      headers: { 'X-Taskmaster-Pairing-Code': pairing.pairingCode }
    });
    const challenge = challengePayload?.challenge;
    if (typeof challenge !== 'string' || !challenge) throw new Error('Manager 未返回有效配对挑战');
    const paired = await request('/v1/pair/extension', {
      method: 'POST',
      authenticated: false,
      body: {
        challenge,
        pairingCode: pairing.pairingCode,
        extensionId: chrome.runtime.id,
        name: 'Eric Task Master'
      }
    });
    const token = paired?.token || paired?.extensionToken;
    if (typeof token !== 'string' || !token) throw new Error('Manager 未返回扩展令牌');
    extensionToken = token;
    trustedManagerIdentity = verifiedIdentity;
    ui.pairingCode.value = '';
    await chrome.storage.local.set({ managerOrigin, extensionToken, trustedManagerIdentity });
    setConnection('connected', '已连接');
    setMessage('配对成功', 'success');
    showWorkspace(true);
    await refreshProfiles();
  } catch (error) {
    setConnection('disconnected', '配对失败');
    setMessage(error.message, 'error');
  } finally {
    ui.pairExtension.disabled = false;
  }
}

function showWorkspace(show) {
  ui.workspace.classList.toggle('hidden', !show);
  ui.sessionCard.classList.toggle('hidden', !show);
  ui.openDashboard.classList.toggle('hidden', !show);
}

function behaviorMode(profile) {
  const value = profile.defaultBehavior || profile.behavior || profile.behaviorMode;
  return PROFILE_MODES.includes(value) ? value : 'fast';
}

function makeButton(label, title, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', action);
  return button;
}

function renderProfiles() {
  ui.profileList.replaceChildren();
  ui.sessionProfile.replaceChildren();
  for (const profile of profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.name;
    ui.sessionProfile.append(option);

    const row = document.createElement('div');
    row.className = 'profile-row';

    const copy = document.createElement('div');
    copy.className = 'profile-copy';
    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = profile.name;
    const state = document.createElement('div');
    state.className = 'profile-state';
    state.textContent = profile.status || profile.state || 'idle';
    copy.append(name, state);

    const mode = document.createElement('select');
    mode.title = '默认行为模式';
    for (const value of PROFILE_MODES) {
      const modeOption = document.createElement('option');
      modeOption.value = value;
      modeOption.textContent = { fast: '快速', human: '拟人', adaptive: '自适应' }[value];
      mode.append(modeOption);
    }
    mode.value = behaviorMode(profile);
    mode.addEventListener('change', () => updateProfile(profile.id, { defaultBehavior: mode.value }));

    const headless = document.createElement('label');
    headless.className = 'checkbox-label';
    headless.title = '不显示 Playwright 浏览器窗口';
    const headlessInput = document.createElement('input');
    headlessInput.type = 'checkbox';
    headlessInput.checked = Boolean(profile.headless);
    headlessInput.addEventListener('change', () => updateProfile(profile.id, { headless: headlessInput.checked }));
    headless.append(headlessInput, '后台');

    const actions = document.createElement('div');
    actions.className = 'profile-actions';
    const isOpen = ['open', 'leased', 'starting'].includes(profile.status || profile.state);
    actions.append(
      makeButton('改名', `重命名 ${profile.name}`, () => renameProfile(profile)),
      makeButton(isOpen ? '关闭' : '打开', `${isOpen ? '关闭' : '打开'} ${profile.name}`, () => setProfileOpen(profile, !isOpen))
    );
    row.append(copy, mode, headless, actions);
    ui.profileList.append(row);
  }

  if (!profiles.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '还没有 Profile';
    ui.profileList.append(empty);
  }
  ui.syncSession.disabled = !profiles.length || !activeSite;
}

async function refreshProfiles() {
  try {
    profiles = unpackList(await request('/v1/profiles'), 'profiles');
    renderProfiles();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      extensionToken = '';
      trustedManagerIdentity = null;
      await chrome.storage.local.remove(['extensionToken', 'trustedManagerIdentity']);
      setConnection('discovering', '配对已失效');
      showWorkspace(false);
    }
    setMessage(error.message, 'error');
  }
}

async function createProfile() {
  const name = ui.newProfileName.value.trim();
  if (!name) return setMessage('请输入 Profile 名称', 'error');
  ui.createProfile.disabled = true;
  try {
    await request('/v1/profiles', {
      method: 'POST',
      body: { name, defaultBehavior: ui.newProfileMode.value, headless: ui.newProfileHeadless.checked }
    });
    ui.newProfileName.value = '';
    ui.newProfileHeadless.checked = false;
    setMessage('Profile 已创建', 'success');
    await refreshProfiles();
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    ui.createProfile.disabled = false;
  }
}

async function updateProfile(id, patch) {
  try {
    await request(`/v1/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
    setMessage('Profile 已更新', 'success');
    await refreshProfiles();
  } catch (error) {
    setMessage(error.message, 'error');
    await refreshProfiles();
  }
}

async function renameProfile(profile) {
  const name = prompt('新的 Profile 名称', profile.name)?.trim();
  if (name && name !== profile.name) await updateProfile(profile.id, { name });
}

async function setProfileOpen(profile, shouldOpen) {
  try {
    const operation = shouldOpen ? 'open' : 'close';
    await request(`/v1/profiles/${encodeURIComponent(profile.id)}/${operation}`, {
      method: 'POST',
      timeoutMs: shouldOpen ? PROFILE_OPEN_REQUEST_TIMEOUT_MS : PROFILE_CLOSE_REQUEST_TIMEOUT_MS
    });
    setMessage(shouldOpen ? 'Profile 正在打开' : 'Profile 已关闭', 'success');
    await refreshProfiles();
  } catch (error) {
    setMessage(error.message, 'error');
    await refreshProfiles().catch(() => {});
  }
}

function mapCookie(cookie) {
  const mapped = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    hostOnly: Boolean(cookie.hostOnly),
    session: Boolean(cookie.session),
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: cookie.sameSite
  };
  if (Number.isFinite(cookie.expirationDate)) mapped.expirationDate = cookie.expirationDate;
  if (cookie.partitionKey?.topLevelSite) {
    mapped.partitionKey = {
      topLevelSite: cookie.partitionKey.topLevelSite,
      ...(typeof cookie.partitionKey.hasCrossSiteAncestor === 'boolean'
        ? { hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor }
        : {})
    };
  }
  return mapped;
}

function readLocalStorageForTransfer() {
  const entries = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const name = localStorage.key(index);
    if (name !== null) entries.push({ name, value: localStorage.getItem(name) ?? '' });
  }
  return entries;
}

async function syncCurrentSite() {
  const profileId = ui.sessionProfile.value;
  if (!profileId) return setMessage('请选择 Profile，并打开一个 HTTP 网站', 'error');
  ui.syncSession.disabled = true;
  setMessage('等待当前网站授权…');
  try {
    const response = await runSessionTransfer({
      profileId,
      extensionId: chrome.runtime.id,
      inspectActiveSite,
      verifyManagerIdentity: verifyTrustedManagerIdentity,
      requestPermission: (origin) => chrome.permissions.request({ origins: [origin] }),
      removePermission: (origin) => chrome.permissions.remove({ origins: [origin] }),
      containsPermission: (origin) => chrome.permissions.contains({ origins: [origin] }),
      readCookies: async (site) => (
        await chrome.cookies.getAll({ url: site.url.href })
      ).map(mapCookie),
      readLocalStorage: async (site) => {
        const execution = await chrome.scripting.executeScript({
          target: { tabId: site.tabId },
          func: readLocalStorageForTransfer
        });
        return Array.isArray(execution?.[0]?.result) ? execution[0].result : [];
      },
      sendSession: ({ profileId: selectedProfileId, bundle }) => request(
        `/v1/profiles/${encodeURIComponent(selectedProfileId)}/session`,
        { method: 'POST', timeoutMs: SESSION_TRANSFER_REQUEST_TIMEOUT_MS, body: bundle }
      )
    });
    const status = response?.status;
    const messages = {
      partial: '登录态已导入；会话 Cookie 最长保留 12 小时，请打开 Profile 确认登录',
      imported: '登录态已导入，请打开目标 Profile 确认登录',
      manual_login_required: '该网站需要在目标 Profile 中人工登录',
      failed: '登录态同步失败'
    };
    setMessage(messages[status] || '同步完成，请打开目标 Profile 确认登录', status === 'partial' ? 'success' : '');
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    ui.syncSession.disabled = !profiles.length || !activeSite;
  }
}

async function inspectActiveSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab?.url || '');
    if (!['http:', 'https:'].includes(url.protocol) || !Number.isInteger(tab.id)) throw new Error('unsupported');
    activeSite = { tabId: tab.id, url };
    ui.currentOrigin.textContent = url.origin;
  } catch {
    activeSite = null;
    ui.currentOrigin.textContent = '当前页面不可同步';
  }
  renderProfiles();
  return activeSite;
}

async function saveOrigin() {
  try {
    managerOrigin = normalizeLoopbackOrigin(ui.managerOrigin.value);
    extensionToken = '';
    trustedManagerIdentity = null;
    ui.managerOrigin.value = managerOrigin;
    await chrome.storage.local.set({ managerOrigin });
    await chrome.storage.local.remove(['extensionToken', 'trustedManagerIdentity']);
    setMessage('地址已保存，请重新配对', 'success');
    await discover();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function openDashboard() {
  try {
    const authorization = await request('/v1/dashboard/authorize', {
      method: 'POST',
      body: {}
    });
    const url = new URL('/dashboard', managerOrigin);
    url.hash = new URLSearchParams({ code: authorization.code }).toString();
    await chrome.tabs.create({ url: url.href });
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function initialize() {
  if (typeof chrome.storage.local.setAccessLevel === 'function') {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
  const stored = await chrome.storage.local.get([
    'managerOrigin',
    'extensionToken',
    'trustedManagerIdentity'
  ]);
  try {
    managerOrigin = normalizeLoopbackOrigin(stored.managerOrigin || DEFAULT_MANAGER_ORIGIN);
  } catch {
    managerOrigin = DEFAULT_MANAGER_ORIGIN;
  }
  extensionToken = typeof stored.extensionToken === 'string' ? stored.extensionToken : '';
  trustedManagerIdentity = stored.trustedManagerIdentity &&
    stored.trustedManagerIdentity.origin === managerOrigin &&
    stored.trustedManagerIdentity.version === EXTENSION_VERSION
    ? stored.trustedManagerIdentity
    : null;
  if (extensionToken && !trustedManagerIdentity) {
    extensionToken = '';
    await chrome.storage.local.remove(['extensionToken', 'trustedManagerIdentity']);
  }
  ui.managerOrigin.value = managerOrigin;
  await inspectActiveSite();
  await discover();
}

const initialized = initialize();

function afterInitialize(handler) {
  return (...args) => {
    void initialized
      .then(() => handler(...args))
      .catch((error) => setMessage(error.message || '控制面板初始化失败', 'error'));
  };
}

ui.saveOrigin.addEventListener('click', afterInitialize(saveOrigin));
ui.discoverManager.addEventListener('click', afterInitialize(discover));
ui.pairExtension.addEventListener('click', afterInitialize(pair));
ui.createProfile.addEventListener('click', afterInitialize(createProfile));
ui.refreshProfiles.addEventListener('click', afterInitialize(refreshProfiles));
ui.syncSession.addEventListener('click', afterInitialize(syncCurrentSite));
ui.openDashboard.addEventListener('click', afterInitialize(openDashboard));
