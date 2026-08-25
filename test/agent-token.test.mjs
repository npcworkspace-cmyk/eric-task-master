import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  AgentTokenError,
  authenticateAgentToken,
  issueAgentToken,
  normalizeAgentName
} from '../src/lib/agent-token.mjs';

const MANAGER_TOKEN = 'manager-secret-'.padEnd(48, 'x');

function signedToken(payload, managerToken = MANAGER_TOKEN) {
  const signature = createHmac('sha256', managerToken).update(payload, 'utf8').digest('base64url');
  return `${payload}.${signature}`;
}

test('ETMA2 binds canonical client ID and normalized Unicode display name', () => {
  const issued = issueAgentToken(MANAGER_TOKEN, {
    clientId: 'codex.fixture',
    name: '  新 Agent Cafe\u0301 🤖  '
  });
  assert.match(issued.token, /^ETMA2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.token.length <= 512, true);
  assert.deepEqual(issued.agent, { clientId: 'codex.fixture', name: '新 Agent Café 🤖' });
  assert.deepEqual(authenticateAgentToken(issued.token, MANAGER_TOKEN), issued.agent);
  assert.equal(issueAgentToken(MANAGER_TOKEN, issued.agent).token, issued.token);
});

test('ETMA2 rejects tampering, non-canonical base64url, invalid UTF-8, and ETMA1', () => {
  const issued = issueAgentToken(MANAGER_TOKEN, { clientId: 'codex.fixture', name: 'Codex' });
  const parts = issued.token.split('.');
  const tamperedName = Buffer.from('Other', 'utf8').toString('base64url');
  assert.equal(authenticateAgentToken([parts[0], parts[1], tamperedName, parts[3]].join('.'), MANAGER_TOKEN), null);
  assert.equal(authenticateAgentToken(`${parts[0]}.${parts[1]}=.${parts[2]}.${parts[3]}`, MANAGER_TOKEN), null);
  assert.equal(authenticateAgentToken(signedToken(`ETMA2.${parts[1]}._w`), MANAGER_TOKEN), null);
  assert.equal(authenticateAgentToken(`ETMA1.${parts[1]}.${parts[3]}`, MANAGER_TOKEN), null);
  assert.equal(authenticateAgentToken(`${issued.token}.extra`, MANAGER_TOKEN), null);
  assert.equal(authenticateAgentToken('x'.repeat(513), MANAGER_TOKEN), null);
});

test('Agent names enforce controls, Unicode code points, and UTF-8 byte bounds', () => {
  for (const value of [
    'Agent\nName',
    '\tAgent',
    `Agent${String.fromCharCode(0x7f)}`,
    `Agent${String.fromCharCode(0x85)}`,
    'Agent\u202eadmin',
    'Agent\u2066admin\u2069',
    'A\u2028B',
    'A\u2029B',
    'Agent\u200bAdmin'
  ]) {
    assert.throws(() => normalizeAgentName(value), (error) => (
      error instanceof AgentTokenError && error.code === 'INVALID_AGENT_NAME'
    ));
  }
  assert.equal(normalizeAgentName('a'.repeat(80)), 'a'.repeat(80));
  assert.equal(normalizeAgentName('🤖'.repeat(40)), '🤖'.repeat(40));
  assert.throws(() => normalizeAgentName('a'.repeat(81)), { code: 'INVALID_AGENT_NAME' });
  assert.throws(() => normalizeAgentName(`${'é'.repeat(79)}🤖`), { code: 'INVALID_AGENT_NAME' });
  assert.throws(() => normalizeAgentName('\ud800'), { code: 'INVALID_AGENT_NAME' });
  assert.throws(() => normalizeAgentName('   '), { code: 'INVALID_AGENT_NAME' });
});

test('reserved Agent client IDs are rejected case-insensitively', () => {
  for (const clientId of ['Manager-Admin', 'DASHBOARD', 'Dashboard:forged', 'TASK:forged']) {
    assert.throws(
      () => issueAgentToken(MANAGER_TOKEN, { clientId, name: 'Agent' }),
      { code: 'RESERVED_CLIENT_ID' }
    );
  }
});

test('ETMA2 is invalid after Manager token rotation', () => {
  const oldToken = issueAgentToken(MANAGER_TOKEN, { clientId: 'codex.fixture', name: 'Codex' }).token;
  const rotatedManagerToken = 'rotated-manager-secret-'.padEnd(48, 'y');
  assert.equal(authenticateAgentToken(oldToken, rotatedManagerToken), null);
  const rotated = issueAgentToken(rotatedManagerToken, { clientId: 'codex.fixture', name: 'Codex' });
  assert.deepEqual(authenticateAgentToken(rotated.token, rotatedManagerToken), rotated.agent);
});
