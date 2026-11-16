import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as playwright from 'playwright';
import { createFastBrowser } from '../src/runtime/fast-browser.mjs';
import { createFastSession } from '../src/runtime/fast-session.mjs';
import { launchChromeProfile } from '../src/runtime/browser-engine.mjs';
import { removeTestTree } from './test-fs.mjs';

async function fixture(t, onDurable = async () => {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etm-boundaries-'));
  const actual = { applied: 0, wrong: 0 };
  const server = http.createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'POST') {
      if (request.url === '/applied') actual.applied++;
      else actual.wrong++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(actual)); return;
    }
    const replacement = request.url === '/replacement';
    response.setHeader('content-type', 'text/html;charset=utf-8');
    response.end('<!doctype html><title>Local boundary acceptance</title><h1>Fictional local fixture</h1>'
      + `<button onclick="fetch('${replacement ? '/wrong' : '/applied'}',{method:'POST'})">Save</button>`
      + '<button id="header" onclick="window.headerClicks=(window.headerClicks||0)+1">Persistent header</button><div id="rows"></div>');
  });
  let context, browser, session;
  t.after(async () => {
    if (session) await session.dispose(); else await browser?.dispose();
    await context?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('etm-boundaries-'));
    await removeTestTree(resolved);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await launchChromeProfile(playwright, { userDataDir: path.join(directory, 'profile') }, { headless: true });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(origin + '/approved', { waitUntil: 'domcontentloaded' });
  browser = createFastBrowser({ page, context, showCursor: false });
  const authorization = { scope: 'profile', version: 1, accountId: 'local-test-profile', resourceIds: ['*'], origins: [origin], allowedActions: ['*'], expiresAt: null };
  const records = [];
  session = createFastSession({ page, browserAdapter: browser, signal: new AbortController().signal,
    input: { operationId: 'local-boundaries', authorization },
    durable: async (type, payload) => {
      records.push({ type, status: payload.status, actionId: payload.actionId });
      await onDurable({ type, payload, page, origin });
      return type === 'authorize' ? { authorization: { ...authorization } } : { acknowledged: true };
    }
  });
  let sequence = 0;
  const command = (kind, payload = {}) => session.execute({ schemaVersion: 1, commandId: `local-boundary-${++sequence}`,
    operationId: 'local-boundaries', authorizationVersion: 1, kind, payload });
  assert.equal((await command('observe')).status, 'confirmed');
  return { page, browser, session, command, actual, records };
}

test('real Chrome rejects a replacement document reached while the prepared action ACK is pending', { timeout: 20000 }, async t => {
  const f = await fixture(t, async ({ type, payload, page, origin }) => {
    if (type === 'action' && payload.status === 'prepared') await page.goto(origin + '/replacement', { waitUntil: 'domcontentloaded' });
  });
  const reply = await f.command('batch', { actions: [{ actionId: 'replacement-save', type: 'click', target: { role: 'button', name: 'Save' } }], preconditions: [], verify: [] });
  assert.equal(reply.status, 'unknown');
  assert.equal(reply.reason, 'WRITE_RESULT_UNKNOWN');
  assert.equal(reply.result.details.cause, 'STALE_OBSERVATION');
  assert.ok(f.page.url().endsWith('/replacement'));
  assert.deepEqual(f.actual, { applied: 0, wrong: 0 }, 'neither the original nor the same-named replacement may receive a click');
  assert.ok(f.records.some(record => record.type === 'action' && record.status === 'initiated'));
  await f.command('observe');
  const retry = await f.command('batch', { actions: [{ actionId: 'must-not-retry', type: 'click', target: { role: 'button', name: 'Save' } }], preconditions: [], verify: [] });
  assert.equal(retry.reason, 'RECONCILE_REQUIRED');
  assert.deepEqual(f.actual, { applied: 0, wrong: 0 });
});

test('real Chrome never receives a click after its initiated acknowledgement consumes the group deadline', { timeout: 20000 }, async t => {
  const f = await fixture(t, async ({ type, payload }) => {
    if (type === 'action' && payload.status === 'initiated') await new Promise(resolve => setTimeout(resolve, 500));
  });
  const reply = await f.command('batch', { timeoutMs: 300,
    actions: [{ actionId: 'late-ack-save', type: 'click', target: { role: 'button', name: 'Save' } }], preconditions: [], verify: [] });
  assert.equal(reply.status, 'unknown');
  assert.equal(reply.reason, 'WRITE_RESULT_UNKNOWN');
  assert.equal(reply.result.details.cause, 'CONDITION_TIMEOUT');
  assert.ok(f.records.some(record => record.type === 'action' && record.status === 'initiated'), 'the fixture must exercise the late initiated-ACK boundary, not an earlier preflight failure');
  assert.deepEqual(f.actual, { applied: 0, wrong: 0 });
  assert.equal(f.session.unresolved, true);
});

test('real Chrome retains a stable current-scene ref through both bounded caches after 1000 changing nodes', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const first = await f.browser.observe({ maxItems: 40, maxChars: 24000 });
  const original = first.items.find(item => item.name === 'Persistent header');
  assert.ok(original?.ref);
  let latest;
  for (let round = 0; round < 54; round++) {
    await f.page.evaluate(round => {
      const rows = document.getElementById('rows');
      rows.replaceChildren(...Array.from({ length: 19 }, (_, index) => {
        const button = document.createElement('button'); button.textContent = `Row ${round}-${index}`; return button;
      }));
    }, round);
    latest = await f.browser.observe({ maxItems: 40, maxChars: 24000 });
    assert.equal(latest.items.find(item => item.name === 'Persistent header')?.ref, original.ref);
    assert.equal(await f.browser.read({ ref: original.ref }), 'Persistent header');
  }
  assert.ok(!latest.omitted?.after);
  assert.ok(f.browser.metrics().targetReferences <= 1000);
  await f.browser.act({ type: 'click', target: { ref: original.ref } });
  assert.equal(await f.page.evaluate(() => window.headerClicks), 1, 'the original node must remain resolvable inside the page-side selector registry too');
  assert.deepEqual(f.actual, { applied: 0, wrong: 0 });
});
