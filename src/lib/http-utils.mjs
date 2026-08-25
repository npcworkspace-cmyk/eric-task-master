import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

export class HttpError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function sendJson(response, statusCode, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': body.length,
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  response.end(body);
}

export function sendEmpty(response, statusCode, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': 0,
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  response.end();
}

export async function readJson(request, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const type = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `JSON body exceeds ${maxBytes} bytes`);
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `JSON body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  if (!length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new HttpError(400, 'INVALID_JSON_BODY', 'JSON body must be an object');
    }
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

export function parseBearer(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

export function requestOrigin(request) {
  const origin = request.headers.origin;
  return typeof origin === 'string' ? origin : null;
}

export function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-taskmaster-connection-id',
    'access-control-allow-credentials': 'true',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}

export async function serveStatic(response, rootDirectory, relativePath) {
  const root = resolve(rootDirectory);
  const requested = relativePath === '' || relativePath.endsWith('/')
    ? `${relativePath}index.html`
    : relativePath;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'Invalid path encoding');
  }
  if (decoded.includes('\0')) throw new HttpError(400, 'INVALID_PATH', 'Invalid path');
  let filePath = resolve(root, decoded.replace(/^[/\\]+/, ''));
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    throw new HttpError(403, 'PATH_OUTSIDE_DASHBOARD', 'Dashboard path is not allowed');
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!fileStat?.isFile()) {
    filePath = resolve(root, 'index.html');
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new HttpError(404, 'DASHBOARD_NOT_FOUND', 'Dashboard is not installed');
      }
      throw error;
    }
  }

  const body = await readFile(filePath);
  response.writeHead(200, {
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=300',
    'content-length': body.length,
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  });
  response.end(body);
}
