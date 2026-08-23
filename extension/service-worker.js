const DEFAULT_MANAGER_ORIGIN = 'http://127.0.0.1:19946';

const BADGES = Object.freeze({
  connected: { text: '●', color: '#18864b' },
  discovering: { text: '●', color: '#c58a00' },
  disconnected: { text: '●', color: '#c83f3f' }
});

async function setBadge(status) {
  const badge = BADGES[status] ?? BADGES.disconnected;
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

async function initialize() {
  if (typeof chrome.storage.local.setAccessLevel === 'function') {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
  const stored = await chrome.storage.local.get(['managerOrigin', 'extensionToken']);
  if (!stored.managerOrigin) {
    await chrome.storage.local.set({ managerOrigin: DEFAULT_MANAGER_ORIGIN });
  }
  await setBadge(stored.extensionToken ? 'discovering' : 'disconnected');
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'manager-status') {
    void setBadge(message.status);
  }
});
