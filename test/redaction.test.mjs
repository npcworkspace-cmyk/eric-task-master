import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publicTask as publicManagerTask } from '../src/contracts.mjs';
import { publicProfile as publicManagerProfile } from '../src/contracts.mjs';
import { isSensitiveKey, redactPublicText, redactSensitiveText, redactSensitiveValue } from '../src/lib/redaction.mjs';
import {
  publicArtifactRead,
  publicProfile as publicMcpProfile,
  publicTask as publicMcpTask,
  redactText
} from '../src/mcp/public-view.mjs';
import { closeTaskBrowserContext, runTaskWorker } from '../src/runtime/task-worker.mjs';

const MARKER = 'redteam-marker-7Vv9pQ';

const variants = [
  `token=${MARKER}`,
  `api_key: ${MARKER}`,
  `apiKey = "${MARKER}"`,
  `x-api-key=${MARKER}`,
  `session_token: '${MARKER}'`,
  `sessionId=${MARKER}`,
  `client_secret=${MARKER}`,
  `OPENAI_API_KEY=${MARKER}`,
  `github_token: ${MARKER}`,
  `private_key=${MARKER}`,
  `credential=${MARKER}`,
  `Authorization: Bearer ${MARKER}`,
  `Cookie: sid=${MARKER}; theme=dark`,
  `https://example.test/path?auth=${MARKER}&page=1`,
  `standalone Bearer ${MARKER}`
];

test('central text redaction covers credential spellings used by tasks and APIs', () => {
  for (const variant of variants) {
    const redacted = redactSensitiveText(`before ${variant} after`);
    assert.equal(redacted.includes(MARKER), false, variant);
    assert.match(redacted, /\[REDACTED\]/, variant);
  }
});

test('central object redaction drops sensitive keys and scrubs nested strings', () => {
  for (const key of ['token', 'managerToken', 'apiKey', 'OPENAI_API_KEY', 'x-api-key', 'session_token', 'sessionId', 'privateKey', 'headers', 'cookie']) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  const safe = redactSensitiveValue({
    apiKey: MARKER,
    nested: {
      note: `session_token=${MARKER}`,
      items: [`https://example.test/?token=${MARKER}`]
    }
  });
  assert.equal('apiKey' in safe, false);
  assert.equal(JSON.stringify(safe).includes(MARKER), false);
});

test('public text redaction preserves ordinary URLs while removing URL credentials and embedded local paths', () => {
  assert.equal(redactPublicText('https://example.test/path'), 'https://example.test/path');
  const redacted = redactPublicText(
    "ENOENT C:\\Users\\eric\\private.txt /home/eric/private.txt /root/acme/private.db /workspace/customer/auth-state.json /etc/taskmaster/internal.conf /opt/vendor/private.log file:///root/private.txt https://user:pass@example.test/callback?code=oauth-secret#fragment"
  );
  assert.equal(redacted.includes('C:\\Users'), false);
  assert.equal(redacted.includes('/home/eric'), false);
  for (const privatePath of ['/root/acme', '/workspace/customer', '/etc/taskmaster', '/opt/vendor']) {
    assert.equal(redacted.includes(privatePath), false);
  }
  assert.equal(redacted.includes('user:pass'), false);
  assert.equal(redacted.includes('oauth-secret'), false);
  assert.equal(redacted.includes('file:///'), false);
  assert.equal(redacted.includes('https://example.test/callback'), true);
  assert.doesNotThrow(() => new URL(redacted.split(' ').at(-1)));
});

test('Manager Profile view is an allowlist that ignores future private runtime fields', () => {
  const safe = publicManagerProfile({
    id: 'profile_safe',
    name: 'Safe',
    state: 'idle',
    defaultBehavior: 'fast',
    headless: true,
    browserEngine: 'chromium',
    userDataDir: 'C:/private/profile',
    lease: { ownerId: 'secret' },
    launchOptions: { proxy: { username: 'eric', password: MARKER } },
    futureCredential: MARKER
  });
  assert.deepEqual(safe, {
    id: 'profile_safe',
    name: 'Safe',
    state: 'idle',
    defaultBehavior: 'fast',
    headless: true,
    browserEngine: 'chromium'
  });
  assert.equal(JSON.stringify(safe).includes(MARKER), false);
});

test('Manager and MCP Profile views share the same nullable public contract', () => {
  const profile = {
    id: 'profile_contract',
    name: 'Contract',
    kind: 'persistent',
    state: 'idle',
    defaultBehavior: 'adaptive',
    headless: false,
    browserEngine: 'chromium',
    access: 'private',
    ownerClientId: 'agent-owner',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:01:00.000Z',
    lastUsedAt: null,
    lastOpenedAt: null,
    userDataDir: 'C:/private/profile'
  };
  const managerView = publicManagerProfile(profile);
  assert.deepEqual(publicMcpProfile(managerView), managerView);
});

test('Manager and MCP public task views never return credential markers in summary or evidence', () => {
  const task = {
    id: 'task_redaction',
    state: 'completed',
    completion: { verifiedAt: '2026-08-24T00:00:01.000Z', integrity: 'verified' },
    summary: `api_key=${MARKER}`,
    result: {
      summary: `session_token: ${MARKER}; ENOENT C:\\Users\\eric\\private.txt`,
      evidence: [
        ...variants.map((value, index) => ({ kind: 'note', label: `case-${index}`, value })),
        { kind: 'url', label: 'valid-url', value: `https://user:pass@example.test/callback?code=${MARKER}` }
      ]
    },
    error: {
      code: 'TASK_FAILED',
      message: `x-api-key=${MARKER}`
    },
    currentActivity: {
      phase: 'clicking',
      status: 'unknown',
      updatedAt: '2026-08-24T00:00:00.000Z',
      selector: `#secret-${MARKER}`,
      input: MARKER,
      url: `https://example.test/?token=${MARKER}`,
      customName: MARKER
    },
    nested: {
      safeMessage: `token=${MARKER}`,
      sessionToken: MARKER
    },
    futureInternalState: { harmlessLookingName: MARKER }
  };
  const managerView = publicManagerTask(task);
  assert.equal(JSON.stringify(managerView).includes(MARKER), false);
  assert.equal(JSON.stringify(managerView).includes('C:\\Users\\eric'), false);
  assert.equal(JSON.stringify(managerView).includes('user:pass'), false);
  assert.equal(managerView.result.evidence.at(-1).value, 'https://example.test/callback');
  assert.equal('nested' in managerView, false);
  assert.equal('futureInternalState' in managerView, false);
  assert.deepEqual(managerView.currentActivity, {
    phase: 'clicking',
    status: 'unknown',
    updatedAt: '2026-08-24T00:00:00.000Z'
  });
  const mcpView = publicMcpTask(task);
  assert.equal(JSON.stringify(mcpView).includes(MARKER), false);
  assert.equal(mcpView.evidence.at(-1).value, 'https://example.test/callback');
  assert.doesNotThrow(() => new URL(mcpView.evidence.at(-1).value));
  assert.equal(redactText(variants.join('\n')).includes(MARKER), false);
});

test('Manager public task projection is idempotent for verified resume state', () => {
  const task = {
    id: 'task_resume_contract',
    supportsResume: true,
    state: 'failed',
    checkpoint: {
      path: 'C:/private/checkpoint.json',
      attempt: 1,
      savedAt: '2026-08-24T00:00:00.000Z',
      sha256: 'a'.repeat(64),
      sizeBytes: 128
    },
    resumeCheckpointValid: true,
    cleanup: { browserClosed: true, leaseReleased: true, workerExited: true, settled: true }
  };
  const once = publicManagerTask(task);
  assert.equal(once.resumeAvailable, true);
  assert.deepEqual(publicManagerTask(once), once);
});

test('declared Agent-visible artifact bytes are preserved exactly', () => {
  const chunk = '{"token":"ordinary-business-value","count":1}\n';
  const result = publicArtifactRead({
    artifact: {
      id: 'artifact_business_data',
      name: 'business.jsonl',
      kind: 'artifact',
      mimeType: 'application/x-ndjson',
      sizeBytes: Buffer.byteLength(chunk),
      agentVisible: true
    },
    offset: 0,
    nextOffset: Buffer.byteLength(chunk),
    eof: true,
    encoding: 'utf8',
    chunk
  }, 'artifact_business_data');
  assert.equal(result.chunk, chunk);
  assert.deepEqual(JSON.parse(result.chunk), { token: 'ordinary-business-value', count: 1 });
});

test('task worker scrubs a module result before it crosses the child-process boundary', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-redaction-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    'export async function run() {',
    `  return { summary: 'token=${MARKER}', evidence: [{ kind: 'note', value: 'x-api-key=${MARKER}' }] };`,
    '}',
    ''
  ].join('\n'));
  const page = { isClosed: () => false };
  const context = {
    pages: () => [page],
    async close() {}
  };
  const outcome = await runTaskWorker({
    taskId: 'task_redaction_worker',
    modulePath,
    outputDir: path.join(root, 'output'),
    checkpointPath: path.join(root, 'checkpoint.json'),
    input: {},
    behavior: 'fast',
    profile: { userDataDir: path.join(root, 'profile'), browserEngine: 'chromium' },
    heartbeatMs: 1_000,
    timeoutMs: 5_000
  }, {
    loadPlaywright: async () => ({
      chromium: { async launchPersistentContext() { return context; } }
    })
  });
  assert.equal(outcome.state, 'completed');
  assert.equal(JSON.stringify(outcome).includes(MARKER), false);
});

test('task worker does not claim browser cleanup when context close fails', async (t) => {
  assert.equal(await closeTaskBrowserContext({
    async close() { throw new Error('close failed'); }
  }, 50), false);
  assert.equal(await closeTaskBrowserContext({ async close() {} }, 50), true);
  assert.equal(await closeTaskBrowserContext(null, 50), true);
});
