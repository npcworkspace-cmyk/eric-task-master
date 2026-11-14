#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createSingleSendTransport, jsonTransport } from '../src/runtime/single-send-transport.mjs';

const output = path.resolve(process.argv[2]); await mkdir(output, { recursive: true }); assert.deepEqual(await readdir(output), []);
const cases = new Map(), checks = [], blocked = [], timers = new Set(); let context, helper, current, release, entered, failure;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost'); const id = u.searchParams.get('id');
  if (req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const item = cases.get(id); if (!item) { res.writeHead(400); res.end(); return; }
    item.effects.push({ at: new Date().toISOString(), url: req.url, bytes: Buffer.byteLength(raw) });
    req.socket.once('close', () => { item.socketClosed = true; item.socketClosedAt = new Date().toISOString(); });
    if (item.mode === 'hold') { item.accepted = true; return; }
    if (item.mode === 'redirect') { res.writeHead(302, { location: '/api/save?id=unexpected-redirect' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
  }
  if (u.pathname === '/page') {
    if (!cases.has(id)) { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><button id="save">Submit synthetic approved request</button><iframe id="child" src="/frame"></iframe><output id="state">ready</output><script>
const id=new URL(location.href).searchParams.get('id'); const mode=id.slice('case-'.length);
const endpoint='/api/save?id='+encodeURIComponent(id); const data={id,value:'approved'}; window.settled=false;
async function send(extra={}) {try{return await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',...(mode==='auth'?{authorization:'synthetic-not-a-secret'}:{})},body:JSON.stringify(mode==='wrong-body'?{id:data.id,value:'wrong'}:data),...extra})}catch{return null}}
document.querySelector('#save').onclick=async()=>{
if(mode==='iframe'){try{await document.querySelector('#child').contentWindow.fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)})}catch{}}
else if(mode==='newtab'){const form=document.createElement('form');form.method='POST';form.target='_blank';form.action=endpoint;document.body.append(form);form.submit()}
else if(mode==='double')await Promise.allSettled([send(),send()]);
else {await send();if(mode==='late')setTimeout(()=>send(),200)}
window.settled=true;document.querySelector('#state').textContent='settled'};</script>`); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html>same-origin empty frame');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
let browserClosed = false, serverClosed = false;
try {
  context = await chromium.launchPersistentContext(path.join(output, 'owned-profile'), { channel: 'chrome', headless: false, serviceWorkers: 'block' });
  helper = await createSingleSendTransport({ context, onBlocked: async (event) => blocked.push(event), authorizeForward: async () => {
    if (['stop-during-auth', 'takeover-during-auth', 'revoke-during-auth'].includes(current.mode)) { entered(); await new Promise((resolve) => { release = resolve; }); if (current.mode === 'revoke-during-auth') throw new Error('Authorization revoked'); }
  } });
  for (const mode of ['normal', 'double', 'late', 'wrong-body', 'wrong-url', 'iframe', 'newtab', 'auth', 'redirect', 'stop-during-auth', 'takeover-during-auth', 'revoke-during-auth', 'hold']) {
    const id = `case-${mode}`; current = { id, mode, effects: [], socketClosed: false }; cases.set(id, current); const item = current;
    const page = await context.newPage(); await page.goto(`${origin}/page?id=${id}`); await page.locator('#child').waitFor();
    const url = `${origin}/api/save?id=${id}`; const guard = jsonTransport(mode === 'wrong-url' ? `${url}-other` : url, { id, value: 'approved' });
    await helper.arm({ page, url: page.url(), guard, actionId: id, commandId: id });
    let authStarted; if (mode.includes('during-auth')) authStarted = new Promise((resolve) => { entered = resolve; });
    await page.locator('#save').click();
    if (authStarted) { await authStarted; if (mode !== 'revoke-during-auth') helper.pause(true); release(); }
    if (mode === 'hold') {
      for (let n = 0; n < 100 && !item.accepted; n++) await pause(20); assert.equal(item.accepted, true);
      const started = performance.now(); helper.pause(true); await context.close(); browserClosed = true;
      for (let n = 0; n < 100 && !item.socketClosed; n++) await pause(20);
      assert.equal(item.socketClosed, true, 'Independent server connection must close, not just a client promise'); item.abortToSocketClosedMs = performance.now() - started;
    }
    let result, code;
    try { result = await helper.finish(id, 3000); } catch (e) { code = e.code; }
    await pause(mode === 'late' ? 600 : 80);
    const allowed = ['normal', 'double', 'late', 'redirect', 'hold'].includes(mode) ? 1 : 0;
    assert.equal(item.effects.length, allowed, `${mode}: independent raw POST/effect count`);
    if (mode === 'normal') assert.equal(result?.forwarded, true);
    if (!['normal', 'late'].includes(mode)) assert.ok(code, `${mode} must not claim confirmed completion`);
    if (['normal', 'late', 'double'].includes(mode)) await assert.rejects(helper.arm({ page, url: page.url(), guard, actionId: `${id}-again`, commandId: 'again' }), { code: 'TRANSPORT_BODY_ALREADY_CONSUMED' });
    checks.push({ mode, approvedActions: 1, independentEffects: item.effects.length, transportResult: result || { code }, socketClosed: item.socketClosed, ...(item.abortToSocketClosedMs ? { abortToSocketClosedMs: item.abortToSocketClosedMs } : {}) });
    process.stdout.write(`${JSON.stringify(checks.at(-1))}\n`);
    helper.pause(false); if (!browserClosed) { await page.close(); for (const other of context.pages()) if (other !== page) await other.close(); }
  }
} catch (e) { failure = { code: e.code, message: e.message, stack: e.stack }; }
finally {
  await helper?.dispose(); if (context && !browserClosed) { await context.close(); browserClosed = true; }
  for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); serverClosed = true;
}
const report = { ok: !failure && checks.length === 13 && browserClosed && serverClosed, checks, blocked, rawEffects: [...cases.values()], failure, cleanup: { browserClosed, serverClosed }, boundary: 'Actual isolated Chrome and production transport helper. Auth races are controlled callbacks; Manager scope checks separately tested. Server records every POST with no dedupe; already accepted effects cannot be recalled. Not root live decisions or a platform-wide guarantee.' };
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(`${JSON.stringify({ ok: report.ok, checks: checks.length, failure, cleanup: report.cleanup })}\n`); if (!report.ok) process.exitCode = 1;
