import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as playwright from 'playwright';
import { createFastBrowser } from '../src/runtime/fast-browser.mjs';
import { launchChromeProfile } from '../src/runtime/browser-engine.mjs';
import { removeTestTree } from './test-fs.mjs';

test('native node-pinned refs preserve reorder, type/drag and same-ref proof while replacements never receive the action', { timeout: 20000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'etm-ref-actions-')); let context, browser;
  t.after(async () => {
    await browser?.dispose(); await context?.close();
    const target = path.resolve(temporary);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('etm-ref-actions-'));
    await removeTestTree(target);
  });
  context = await launchChromeProfile(playwright, { userDataDir: path.join(temporary, 'profile') }, { headless: true });
  const page = context.pages()[0] || await context.newPage();
  await page.setContent(`<!doctype html><title>Native reference actions</title><style>
    body{font:16px Arial;padding:20px}button,textarea{margin:8px;padding:10px}.drag{display:inline-block;width:150px;height:70px;border:2px solid;margin:12px}
    </style><div id="rows"><button id="other">Other</button><button id="target">Target</button></div>
    <label>Note<textarea id="note">old</textarea></label><div><div id="source" class="drag" draggable="true" role="button" aria-label="Drag source">Source</div>
    <div id="destination" class="drag" role="button" aria-label="Drop destination">Drop here</div></div>
    <button disabled>Disabled</button><button>Duplicate</button><button>Duplicate</button>
    <script>window.proof={target:0,wrong:0,drops:0};document.querySelector('#target').onclick=()=>proof.target++;
    document.querySelector('#other').onclick=()=>proof.wrong++;
    document.querySelector('#source').ondragstart=e=>e.dataTransfer.setData('text/plain','same-node');
    document.querySelector('#destination').ondragover=e=>e.preventDefault();
    document.querySelector('#destination').ondrop=e=>{e.preventDefault();if(e.dataTransfer.getData('text/plain')==='same-node')proof.drops++};</script>`);
  assert.equal(await page.getByRole('textbox', { name: 'Note', exact: true }).count(), 1, 'native accessible name excludes the wrapped textarea value');
  browser = createFastBrowser({ page, context });
  const observeRef = async name => {
    const item = (await browser.observe({ maxChars: 24000 })).items.find(candidate => candidate.name === name);
    assert.ok(item, `Fixture control ${name} must be present in the actual scene`); return item.ref;
  };
  const targetRef = await observeRef('Target');
  await page.evaluate(() => document.querySelector('#rows').prepend(document.querySelector('#target')));
  await browser.act({ type: 'click', target: { ref: targetRef } }, 1500);
  assert.deepEqual(await page.evaluate(() => window.proof), { target: 1, wrong: 0, drops: 0 });
  const noteRef = await observeRef('Note');
  await browser.act({ type: 'fill', target: { ref: noteRef }, value: 'precise' }, 1500);
  assert.equal(await browser.condition({ target: { ref: noteRef }, value: 'precise' }), true);
  await browser.act({ type: 'type', target: { ref: noteRef }, value: ' typed' }, 1500);
  assert.equal(await browser.condition({ target: { ref: noteRef }, value: 'precise typed' }), true);
  const scene = await browser.observe({ maxChars: 24000 });
  await browser.act({ type: 'drag', target: { ref: scene.items.find(item => item.name === 'Drag source').ref },
    to: { ref: scene.items.find(item => item.name === 'Drop destination').ref } }, 1500);
  assert.equal(await page.evaluate(() => proof.drops), 1);
  await assert.rejects(browser.act({ type: 'click', target: { role: 'button', name: 'Duplicate' } }, 500), { code: 'AMBIGUOUS_TARGET' });
  const disabledRef = await observeRef('Disabled');
  await assert.rejects(browser.act({ type: 'click', target: { ref: disabledRef } }, 500), { code: 'TARGET_NOT_ACTIONABLE' });
  const replacedRef = await observeRef('Target');
  await page.evaluate(() => {
    const cover = document.createElement('div'); cover.style.cssText = 'position:fixed;inset:0;background:#fff9;z-index:100'; document.body.append(cover);
    setTimeout(() => { const original = document.querySelector('#target'), replacement = original.cloneNode(true);
      replacement.onclick = () => proof.wrong++; original.replaceWith(replacement); cover.remove(); }, 100);
  });
  await assert.rejects(browser.act({ type: 'click', target: { ref: replacedRef } }, 1500), { code: 'STALE_OBSERVATION' });
  await assert.rejects(browser.observe({ ref: replacedRef, detail: 'full' }), { code: 'STALE_OBSERVATION' });
  assert.deepEqual(await page.evaluate(() => window.proof), { target: 1, wrong: 0, drops: 1 });
});
