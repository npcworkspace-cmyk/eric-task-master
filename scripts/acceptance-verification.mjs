#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runTaskWorker, resumeTaskWorker } from '../src/runtime/task-worker.mjs';
import { probeChromeProfileUsage } from '../src/lib/process-tree.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'Task Master verification '));
const profilePath = path.join(root, 'profile');
const reportDir = path.join(projectRoot, 'artifacts', 'verification-acceptance');
const outputDir = path.join(reportDir, String(Date.now()));
await mkdir(outputDir, { recursive: true });
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Verification fixture</title><h1 id="state">Local verification fixture</h1><p>This is a local test page, not a real challenge.</p><button onclick="document.title=\'Ready fixture\';document.querySelector(\'#state\').textContent=\'Ready to continue\'">Complete fixture</button>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const modulePath = path.join(root, 'job.mjs');
await writeFile(modulePath, `
  export default async function ({ page, input, wait }) {
    await page.goto(input.url, { waitUntil: 'domcontentloaded' });
    await wait({ reason: 'verification' });
    return { title: await page.title() };
  }
`);
let context;
let page;
let browserClosed = false;
let heartbeatCount = 0;
const probes = [];
let callbackFailure;
let verifyHold;
const controller = new AbortController();
const fail = (error) => { callbackFailure = error; controller.abort(); };
try {
  const result = await runTaskWorker({
    taskId: 'verification_acceptance', modulePath,
    profile: { userDataDir: profilePath }, outputDir,
    input: { url: `http://127.0.0.1:${server.address().port}/` },
    timeoutMs: 30_000
  }, {
    signal: controller.signal,
    // Production cadence is separately checked at real 5/10/15/20-minute
    // clock values by verification-wait.test.mjs. This is the live Chrome flow.
    verificationProbeIntervalMs: 400,
    heartbeatIntervalMs: 100,
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async (directory, options) => {
      context = await chromium.launchPersistentContext(directory, options);
      context.on('close', () => { browserClosed = true; });
      page = context.pages()[0] || await context.newPage();
      return context;
    } } }),
    sendMessage: (message) => {
      if (message.type === 'heartbeat') heartbeatCount += 1;
      if (message.type !== 'event' || message.event?.type !== 'verification.probe') return;
      const probe = message.event;
      probes.push(probe);
      if (probe.probe === 2) {
        void page.getByRole('button', { name: 'Complete fixture' }).click().catch(fail);
      }
      if (probe.probe === 4) {
        verifyHold = setTimeout(() => {
          try {
            assert.equal(probes.length, 4, 'No fifth screenshot after exhaustion');
            assert.equal(browserClosed, false, 'Chrome stays open after exhaustion');
            assert.ok(heartbeatCount > 4, 'Heartbeat continues during waiting');
            assert.equal(resumeTaskWorker(null, { waitId: probe.waitId, probeId: 'stale' }), false);
            assert.equal(resumeTaskWorker(null, { waitId: probe.waitId, probeId: probe.probeId }), true);
          } catch (error) { fail(error); }
        }, 650);
      }
    }
  });
  if (callbackFailure) throw callbackFailure;
  assert.equal(result.state, 'finished');
  assert.equal(result.result.title, 'Ready fixture');
  assert.equal(browserClosed, true);
  assert.equal(probes.length, 4);
  assert.ok(probes.every((probe) => probe.screenshotPath));
  for (const probe of probes) {
    const bytes = await readFile(probe.screenshotPath);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  const report = {
    ok: true, fixtureOnly: true, liveChromeCadenceMs: 400,
    productionClockTest: 'test-v3/verification-wait.test.mjs',
    screenshots: probes.map((probe) => probe.screenshotPath),
    heartbeatCount, browserClosed, finalTitle: result.result.title
  };
  await writeFile(path.join(reportDir, 'acceptance.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  clearTimeout(verifyHold);
  controller.abort();
  await context?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  const usage = await probeChromeProfileUsage(profilePath);
  assert.equal(usage, 'inactive', 'Only remove the isolated fixture Profile after Chrome exits');
  assert.equal(path.dirname(root), os.tmpdir());
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
