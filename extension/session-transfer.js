function sessionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function snapshot(site) {
  if (!site || !Number.isInteger(site.tabId) || !(site.url instanceof URL)) {
    throw sessionError('ACTIVE_SITE_REQUIRED', '请选择 Profile，并打开一个 HTTP 网站');
  }
  return { tabId: site.tabId, url: new URL(site.url.href) };
}

function assertUnchanged(expected, actual) {
  const current = snapshot(actual);
  if (current.tabId !== expected.tabId || current.url.origin !== expected.url.origin) {
    throw sessionError('ACTIVE_SITE_CHANGED', '当前标签页或网站已变化，请确认后重试');
  }
  return current;
}

export function sitePermissionPattern(url) {
  return `${url.protocol}//${url.hostname}/*`;
}

export async function runSessionTransfer({
  profileId,
  extensionId,
  inspectActiveSite,
  verifyManagerIdentity,
  requestPermission,
  removePermission,
  containsPermission = async () => false,
  readCookies,
  readLocalStorage,
  sendSession
}) {
  if (!profileId) throw sessionError('PROFILE_REQUIRED', '请选择 Profile，并打开一个 HTTP 网站');
  const selected = snapshot(await inspectActiveSite());

  // No page credential is read until the endpoint has freshly proved the pin.
  await verifyManagerIdentity();
  assertUnchanged(selected, await inspectActiveSite());

  const permission = sitePermissionPattern(selected.url);
  let permissionRequested = false;
  let permissionGranted = false;
  let cookies = [];
  let localStorage = [];
  try {
    permissionRequested = true;
    permissionGranted = await requestPermission(permission);
    if (!permissionGranted) throw sessionError('SITE_PERMISSION_DENIED', '未授予当前网站权限');

    assertUnchanged(selected, await inspectActiveSite());
    const cookieResult = await readCookies(selected);
    if (!Array.isArray(cookieResult)) {
      throw sessionError('SESSION_READ_INVALID', '当前网站登录态读取失败');
    }
    cookies = cookieResult;
    const storageResult = await readLocalStorage(selected);
    if (!Array.isArray(storageResult)) {
      throw sessionError('SESSION_READ_INVALID', '当前网站登录态读取失败');
    }
    localStorage = storageResult;
    assertUnchanged(selected, await inspectActiveSite());

    return await sendSession({
      profileId,
      bundle: {
        origin: selected.url.origin,
        cookies,
        localStorage,
        source: {
          extensionId,
          tabUrl: selected.url.origin
        }
      }
    });
  } finally {
    cookies.splice(0, cookies.length);
    localStorage.splice(0, localStorage.length);
    if (permissionRequested) {
      const removed = await removePermission(permission);
      const remainsGranted = await containsPermission(permission);
      if (remainsGranted || (permissionGranted && removed !== true)) {
        throw sessionError(
          'SITE_PERMISSION_REVOKE_FAILED',
          '当前网站临时权限未能撤销，请在扩展权限设置中立即移除'
        );
      }
    }
  }
}
