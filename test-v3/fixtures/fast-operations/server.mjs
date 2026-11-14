import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

const htmlEscape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const pageScript = `
async function save(url,body,done){if(document.body.dataset.dialog==='true'){alert('Unexpected consent');return}try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok){document.querySelector('#permission-error').hidden=false;return}done(await r.json())}catch{document.querySelector('#permission-error').hidden=false}}
const publish=document.querySelector('#publish');if(publish)publish.onclick=()=>save('/api/reply',{text:document.querySelector('#reply').value},d=>{document.querySelector('#reply-result').textContent=d.replies.at(-1).text});
const budget=document.querySelector('#save-budget');if(budget)budget.onclick=()=>save('/api/budget',{value:Number(document.querySelector('#budget').value)},d=>{document.querySelector('#current-budget').textContent=d.budget});
const config=document.querySelector('#save-config');if(config)config.onclick=()=>save('/api/config',{value:document.querySelector('#config-value').value},d=>{document.querySelector('#current-value').textContent=d.config;document.querySelector('#saved').textContent='saved'});
if(document.body.dataset.ambiguous==='true')document.querySelector('button')?.after(document.querySelector('button').cloneNode(true));
`;

export async function startFixtureServer({ port = 0, stateFile, now = Date.now } = {}) {
  let data = stateFile ? JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}')) : {};
  data = { replies: [], budget: 100, config: 'old-value', savedAt: null, effects: [], flags: {}, ...data };
  const persist = () => stateFile ? writeFile(stateFile, JSON.stringify(data, null, 2), { mode: 0o600 }) : Promise.resolve();
  const page = (kind) => {
    const resource = kind === 'social' ? 'post-1' : kind === 'ads' ? 'campaign-1' : 'config-1';
    const account = data.flags.accountChanged ? 'foreign-account' : 'account-1';
    const common = `<h1>${kind} isolated simulation</h1><p data-account-id="${account}">${account}</p><p data-resource-id="${resource}">${resource}</p><p id="login-expired" ${data.flags.loginExpired ? '' : 'hidden'}>Sign-in session expired</p><p id="permission-error" ${data.flags.permission ? '' : 'hidden'}>Permission denied</p><span data-private>secret-sentinel-private</span><input type="password" value="secret-sentinel-password"><input autocomplete="one-time-code" value="secret-sentinel-otp">`;
    const body = kind === 'social'
      ? `<section id="context"><p id="rules" data-fast-context>No spam. Human review required. Be helpful.${data.flags.longRules ? ' Full community context.'.repeat(210) + ' END-OF-LONG-RULES' : ''}</p><h2 id="post">How should we improve this product?</h2><p id="conversation">Existing comment: reliability matters.</p></section><textarea id="reply"></textarea><button id="publish">Publish reply</button><p id="reply-result">${htmlEscape(data.replies.at(-1)?.text || '')}</p><p id="follow-up">${htmlEscape(data.flags.followUp || 'No new replies')}</p>`
      : kind === 'ads'
        ? `<p id="platform">${data.flags.meta ? 'Meta' : 'Google'}</p><p id="currency">${htmlEscape(data.flags.currency || 'USD')}</p><p id="budget-type">daily</p><p id="data-sufficiency">${data.flags.insufficient ? 'insufficient' : 'sufficient'}</p><p id="data-range">last 7 days</p><p id="data-as-of">${new Date(now()).toISOString()}</p><p id="attribution">7-day click</p><p id="current-budget">${htmlEscape(data.budget)}</p><input id="budget" value="${htmlEscape(data.budget)}"><button id="save-budget">Save budget</button>`
        : `<p id="domain">example.test</p><p id="current-value">${htmlEscape(data.config)}</p><input id="config-value" value="${htmlEscape(data.config)}"><button id="save-config">Save configuration</button><p id="saved">${data.savedAt ? 'saved' : 'not-saved'}</p><p id="propagation">${data.flags.effective ? 'effective' : 'pending'}</p>`;
    return `<!doctype html><html><head><title>Task Master isolated ${kind}</title></head><body data-dialog="${Boolean(data.flags.dialog)}" data-ambiguous="${Boolean(data.flags.ambiguous)}">${common}${body}<script src="/fixture.js"></script></body></html>`;
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (raw.length > 16000) throw new Error('too large'); }
      const value = raw ? JSON.parse(raw) : {};
      if (request.method === 'GET' && url.pathname === '/fixture.js') {
        response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' }); response.end(pageScript); return;
      } else if (request.method === 'POST' && url.pathname === '/control') {
        data.flags = { ...data.flags, ...value };
        if (value.manualBudget !== undefined) data.budget = value.manualBudget;
        await persist();
      } else if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (data.flags.permission) { response.writeHead(403); response.end('{}'); return; }
        if (url.pathname === '/api/reply') data.replies.push({ id: `reply-${data.replies.length + 1}`, text: String(value.text) });
        else if (url.pathname === '/api/budget') data.budget = Number(value.value);
        else if (url.pathname === '/api/config') { data.config = String(value.value); data.savedAt = new Date(now()).toISOString(); }
        else { response.writeHead(404); response.end('{}'); return; }
        data.effects.push({ path: url.pathname, at: new Date(now()).toISOString() });
        await persist();
        if (data.flags.disconnectAfterSubmit) { request.socket.destroy(); return; }
      } else if (request.method === 'GET' && ['/social', '/ads', '/site', '/new-entry/social', '/new-entry/ads', '/new-entry/site'].includes(url.pathname)) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(page(url.pathname.split('/').at(-1))); return;
      } else if (request.method === 'GET' && url.pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, pid: process.pid })); return;
      } else if (request.method === 'GET' && url.pathname !== '/state') { response.writeHead(404); response.end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(data));
    } catch (error) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, origin: `http://127.0.0.1:${server.address().port}`, get state() { return data; }, async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))) {
  const fixture = await startFixtureServer({ port: Number(process.env.FIXTURE_PORT || 0), stateFile: process.env.FIXTURE_STATE_FILE });
  process.stdout.write(`${JSON.stringify({ origin: fixture.origin, pid: process.pid })}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await fixture.close(); process.exit(0); });
}
