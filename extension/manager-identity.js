const IDENTITY_PROTOCOL = 'eric-task-master-identity-v1';
const MANAGER_SERVICE = 'eric-task-master';
const PAIRING_PREFIX = 'ETM1';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function identityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function decodeBase64Url(value, expectedBytes, label) {
  if (typeof value !== 'string' || !BASE64URL.test(value)) {
    throw identityError('MANAGER_IDENTITY_INVALID', `${label} 无效`);
  }
  let binary;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    binary = atob(padded);
  } catch {
    throw identityError('MANAGER_IDENTITY_INVALID', `${label} 无效`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== expectedBytes || encodeBase64Url(bytes) !== value) {
    throw identityError('MANAGER_IDENTITY_INVALID', `${label} 无效`);
  }
  return bytes;
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function validatePin(identity) {
  if (!identity || typeof identity !== 'object' || identity.algorithm !== 'Ed25519') {
    throw identityError('MANAGER_IDENTITY_INVALID', 'Manager 身份 pin 无效');
  }
  decodeBase64Url(identity.publicKey, 32, 'Manager 公钥');
  decodeBase64Url(identity.fingerprint, 32, 'Manager 指纹');
  return {
    algorithm: 'Ed25519',
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint
  };
}

function identityMessage(challenge) {
  return JSON.stringify([
    challenge.protocol,
    challenge.service,
    challenge.version,
    challenge.apiVersion,
    challenge.host,
    challenge.port,
    challenge.nonce
  ]);
}

function normalizeOrigin(origin) {
  const url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw identityError('MANAGER_IDENTITY_BINDING_MISMATCH', 'Manager 地址不是受支持的本机地址');
  }
  return url;
}

function randomNonce(cryptoImpl) {
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

async function fingerprint(publicKey, cryptoImpl) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', decodeBase64Url(publicKey, 32, 'Manager 公钥'));
  return encodeBase64Url(new Uint8Array(digest));
}

export function parsePairingCode(value) {
  if (typeof value !== 'string') throw identityError('INVALID_PAIRING_CODE', '配对码格式无效');
  const parts = value.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PAIRING_PREFIX) {
    throw identityError('INVALID_PAIRING_CODE', '配对码格式无效');
  }
  try {
    decodeBase64Url(parts[1], 16, '配对授权');
    decodeBase64Url(parts[2], 32, 'Manager 指纹');
  } catch {
    throw identityError('INVALID_PAIRING_CODE', '配对码格式无效');
  }
  return { pairingCode: value.trim(), approvalCode: parts[1], fingerprint: parts[2] };
}

export async function fetchAndVerifyManagerIdentity({
  origin,
  version,
  extensionId,
  expectedFingerprint,
  expectedIdentity,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  signal
}) {
  const originUrl = normalizeOrigin(origin);
  const pin = expectedIdentity ? validatePin(expectedIdentity) : null;
  const requiredFingerprint = expectedFingerprint || pin?.fingerprint;
  if (!requiredFingerprint) {
    throw identityError('MANAGER_IDENTITY_PIN_REQUIRED', '缺少 Manager 身份 pin，请重新配对');
  }
  decodeBase64Url(requiredFingerprint, 32, 'Manager 指纹');
  const nonce = randomNonce(cryptoImpl);
  let response;
  try {
    response = await fetchImpl(new URL('/v1/identity/challenge', originUrl), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Taskmaster-Extension-Id': extensionId
      },
      body: JSON.stringify({ nonce }),
      redirect: 'error',
      signal
    });
  } catch {
    throw identityError('MANAGER_IDENTITY_UNVERIFIED', 'Manager 身份挑战失败');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
    throw identityError('MANAGER_IDENTITY_UNVERIFIED', 'Manager 身份响应过大');
  }
  const text = await response.text();
  if (!response.ok || text.length > 16 * 1024) {
    throw identityError('MANAGER_IDENTITY_UNVERIFIED', 'Manager 身份挑战被拒绝');
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw identityError('MANAGER_IDENTITY_UNVERIFIED', 'Manager 身份响应无效');
  }
  const received = validatePin(payload.identity);
  const calculatedFingerprint = await fingerprint(received.publicKey, cryptoImpl);
  if (
    received.fingerprint !== calculatedFingerprint ||
    received.fingerprint !== requiredFingerprint ||
    (pin && received.publicKey !== pin.publicKey)
  ) {
    throw identityError('MANAGER_IDENTITY_MISMATCH', 'Manager 身份与可信 pin 不一致');
  }
  const challenge = payload.challenge;
  const expectedPort = Number(originUrl.port || 80);
  if (
    !challenge ||
    challenge.protocol !== IDENTITY_PROTOCOL ||
    challenge.service !== MANAGER_SERVICE ||
    challenge.version !== version ||
    challenge.apiVersion !== 1 ||
    challenge.host !== originUrl.hostname ||
    challenge.port !== expectedPort ||
    challenge.nonce !== nonce
  ) {
    throw identityError('MANAGER_IDENTITY_BINDING_MISMATCH', 'Manager 身份签名未绑定当前服务地址或版本');
  }
  let valid = false;
  try {
    const publicKey = await cryptoImpl.subtle.importKey(
      'raw',
      decodeBase64Url(received.publicKey, 32, 'Manager 公钥'),
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    valid = await cryptoImpl.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      decodeBase64Url(payload.signature, 64, 'Manager 签名'),
      new TextEncoder().encode(identityMessage(challenge))
    );
  } catch {
    valid = false;
  }
  if (!valid) throw identityError('MANAGER_IDENTITY_SIGNATURE_INVALID', 'Manager 身份签名无效');
  return {
    ...received,
    origin: originUrl.origin,
    service: MANAGER_SERVICE,
    version,
    host: originUrl.hostname,
    port: expectedPort
  };
}

export async function verifyPairingManagerIdentity({ pairingCode, ...options }) {
  const pairing = parsePairingCode(pairingCode);
  const identity = await fetchAndVerifyManagerIdentity({
    ...options,
    expectedFingerprint: pairing.fingerprint
  });
  return { pairing, identity };
}

export async function trustedManagerFetch({
  origin,
  version,
  extensionId,
  trustedIdentity,
  token,
  path,
  method = 'GET',
  body,
  headers: extraHeaders = {},
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  signal
}) {
  if (typeof token !== 'string' || !token) throw identityError('EXTENSION_TOKEN_REQUIRED', '请先配对 Manager');
  const pin = validatePin(trustedIdentity);
  if (trustedIdentity.origin !== normalizeOrigin(origin).origin) {
    throw identityError('MANAGER_IDENTITY_BINDING_MISMATCH', 'Manager 地址与可信身份 pin 不一致');
  }
  await fetchAndVerifyManagerIdentity({
    origin,
    version,
    extensionId,
    expectedIdentity: pin,
    fetchImpl,
    cryptoImpl,
    signal
  });

  const headers = {
    Accept: 'application/json',
    'X-Taskmaster-Extension-Id': extensionId,
    Authorization: `Bearer ${token}`,
    ...extraHeaders
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetchImpl(new URL(path, normalizeOrigin(origin)), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal
  });
}
