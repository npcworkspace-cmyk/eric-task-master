import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signMessage,
  timingSafeEqual,
  verify as verifyMessage
} from 'node:crypto';

export const MANAGER_IDENTITY_PROTOCOL = 'eric-task-master-identity-v1';
export const MANAGER_SERVICE = 'eric-task-master';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const FINGERPRINT_BYTES = 32;

function identityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function decodeBase64Url(value, expectedBytes, label) {
  if (typeof value !== 'string' || !BASE64URL.test(value)) {
    throw identityError('MANAGER_IDENTITY_INVALID', `${label} is invalid`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.length !== expectedBytes ||
    decoded.toString('base64url') !== value
  ) {
    throw identityError('MANAGER_IDENTITY_INVALID', `${label} is invalid`);
  }
  return decoded;
}

function secureEqualString(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function managerIdentityFingerprint(publicKey) {
  const raw = decodeBase64Url(publicKey, PUBLIC_KEY_BYTES, 'Manager public key');
  return createHash('sha256').update(raw).digest('base64url');
}

export function generateManagerIdentity() {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'jwk' }).x;
  return {
    algorithm: 'Ed25519',
    publicKey,
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    fingerprint: managerIdentityFingerprint(publicKey)
  };
}

export function validateManagerIdentityPin(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw identityError('MANAGER_IDENTITY_INVALID', 'Manager identity pin is invalid');
  }
  if (identity.algorithm !== 'Ed25519') {
    throw identityError('MANAGER_IDENTITY_INVALID', 'Manager identity algorithm is invalid');
  }
  decodeBase64Url(identity.publicKey, PUBLIC_KEY_BYTES, 'Manager public key');
  const fingerprint = managerIdentityFingerprint(identity.publicKey);
  decodeBase64Url(identity.fingerprint, FINGERPRINT_BYTES, 'Manager identity fingerprint');
  if (!secureEqualString(identity.fingerprint, fingerprint)) {
    throw identityError('MANAGER_IDENTITY_INVALID', 'Manager identity fingerprint is invalid');
  }
  return {
    algorithm: 'Ed25519',
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint
  };
}

export function validateManagerIdentity(identity) {
  const pin = validateManagerIdentityPin(identity);
  if (typeof identity.privateKey !== 'string' || !BASE64URL.test(identity.privateKey)) {
    throw identityError('MANAGER_IDENTITY_INVALID', 'Manager private identity is invalid');
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({
      key: Buffer.from(identity.privateKey, 'base64url'),
      format: 'der',
      type: 'pkcs8'
    });
  } catch {
    throw identityError('MANAGER_IDENTITY_INVALID', 'Manager private identity is invalid');
  }
  const derivedPublicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  if (!secureEqualString(derivedPublicKey, pin.publicKey)) {
    throw identityError('MANAGER_IDENTITY_INVALID', 'Manager identity key pair does not match');
  }
  return { ...pin, privateKey: identity.privateKey };
}

export function createIdentityNonce() {
  return randomBytes(32).toString('base64url');
}

export function validateIdentityNonce(nonce) {
  const decoded = decodeBase64Url(nonce, 32, 'Manager identity nonce');
  return decoded.toString('base64url');
}

export function managerIdentityMessage(challenge) {
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

function validateBinding(binding) {
  if (
    !binding ||
    typeof binding.service !== 'string' ||
    typeof binding.version !== 'string' ||
    !Number.isInteger(binding.apiVersion) ||
    typeof binding.host !== 'string' ||
    !Number.isInteger(binding.port) ||
    binding.port < 1 ||
    binding.port > 65_535
  ) {
    throw identityError('MANAGER_IDENTITY_BINDING_INVALID', 'Manager identity binding is invalid');
  }
  return binding;
}

export function createManagerIdentityProof(identity, binding) {
  const validatedIdentity = validateManagerIdentity(identity);
  const expected = validateBinding(binding);
  const challenge = {
    protocol: MANAGER_IDENTITY_PROTOCOL,
    service: expected.service,
    version: expected.version,
    apiVersion: expected.apiVersion,
    host: expected.host,
    port: expected.port,
    nonce: validateIdentityNonce(expected.nonce)
  };
  const privateKey = createPrivateKey({
    key: Buffer.from(validatedIdentity.privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8'
  });
  const signature = signMessage(
    null,
    Buffer.from(managerIdentityMessage(challenge), 'utf8'),
    privateKey
  ).toString('base64url');
  return {
    identity: {
      algorithm: validatedIdentity.algorithm,
      publicKey: validatedIdentity.publicKey,
      fingerprint: validatedIdentity.fingerprint
    },
    challenge,
    signature
  };
}

export function verifyManagerIdentityProof(payload, expectedIdentity, expectedBinding) {
  const pin = validateManagerIdentityPin(expectedIdentity);
  const expected = validateBinding(expectedBinding);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw identityError('MANAGER_IDENTITY_UNVERIFIED', 'Manager identity proof is invalid');
  }
  const receivedPin = validateManagerIdentityPin(payload.identity);
  if (
    !secureEqualString(receivedPin.publicKey, pin.publicKey) ||
    !secureEqualString(receivedPin.fingerprint, pin.fingerprint)
  ) {
    throw identityError('MANAGER_IDENTITY_MISMATCH', 'Manager identity does not match the local pin');
  }
  const challenge = payload.challenge;
  if (
    !challenge ||
    challenge.protocol !== MANAGER_IDENTITY_PROTOCOL ||
    challenge.service !== expected.service ||
    challenge.version !== expected.version ||
    challenge.apiVersion !== expected.apiVersion ||
    challenge.host !== expected.host ||
    challenge.port !== expected.port ||
    challenge.nonce !== validateIdentityNonce(expected.nonce)
  ) {
    throw identityError('MANAGER_IDENTITY_BINDING_MISMATCH', 'Manager identity proof binding does not match');
  }
  const signature = decodeBase64Url(payload.signature, SIGNATURE_BYTES, 'Manager identity signature');
  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: pin.publicKey },
    format: 'jwk'
  });
  if (!verifyMessage(
    null,
    Buffer.from(managerIdentityMessage(challenge), 'utf8'),
    publicKey,
    signature
  )) {
    throw identityError('MANAGER_IDENTITY_SIGNATURE_INVALID', 'Manager identity signature is invalid');
  }
  return pin;
}
