#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runTaskWorker, acknowledgeTaskWorkerResume } from '../src/runtime/task-worker.mjs';
import { probeChromeProfileUsage } from '../src/lib/process-tree.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const injectedTiming = { probeIntervalMs: 400, pauseAfterMs: 1_600, heartbeatIntervalMs: 100 };
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
const pauses = [];
const acknowledgements = [];
let waiting;
let resumedCount = 0;
let heartbeatsAtPause = null;
let pausedBeforeFinalScreenshot = false;
let callbackFailure;
let verifyHold;
const controller = new AbortController();
const fail = (error) => { callbackFailure = error; controller.abort(); };
const acceptanceTimeout = setTimeout(() => fail(new Error('Live verification acceptance exceeded 30 seconds')), 30_000);
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
    verificationProbeIntervalMs: injectedTiming.probeIntervalMs,
    verificationPauseAfterMs: injectedTiming.pauseAfterMs,
    heartbeatIntervalMs: injectedTiming.heartbeatIntervalMs,
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async (directory, options) => {
      context = await chromium.launchPersistentContext(directory, options);
      context.on('close', () => { browserClosed = true; });
      page = context.pages()[0] || await context.newPage();
      return context;
    } } }),
    sendMessage: (message) => {
      if (message.type === 'heartbeat') heartbeatCount += 1;
      if (message.type === 'waiting') waiting = message.waiting;
      if (message.type === 'resumed') resumedCount += 1;
      if (message.type === 'event' && message.event?.type === 'verification.paused') {
        pauses.push(message.event);
        heartbeatsAtPause = heartbeatCount;
        pausedBeforeFinalScreenshot = probes.length < 4;
      }
      if (message.type !== 'event' || message.event?.type !== 'verification.probe') return;
      const probe = message.event;
      probes.push(probe);
      if (probe.probe === 2) {
        void page.getByRole('button', { name: 'Complete fixture' }).click().catch(fail);
      }
      if (probe.probe === 4) {
        verifyHold = setTimeout(() => {
          try {
            assert.equal(probes.length, 4, 'No fifth screenshot after automatic pause');
            assert.equal(pauses.length, 1, 'One pause event is independent of screenshot completion');
            assert.equal(pauses[0].waitId, waiting.id);
            assert.equal(pauses[0].automaticPaused, true);
            assert.equal(probe.automaticPaused, true);
            assert.equal(probe.needsAgentDecision, false, 'The final capture is diagnostic after automatic pause');
            assert.equal(browserClosed, false, 'Chrome stays open after automatic pause');
            assert.ok(heartbeatCount > heartbeatsAtPause, 'Heartbeat continues after automatic pause');
            assert.equal(resumedCount, 0, 'A changed fixture page never resumes itself');
            const ack = (message) => acknowledgements.push(message);
            assert.equal(acknowledgeTaskWorkerResume({
              requestId: 'diagnostic_probe_resume', waitId: probe.waitId, probeId: probe.probeId
            }, ack), false);
            assert.equal(acknowledgements.at(-1).reason, 'TASK_VERIFICATION_PAUSED');
            assert.equal(acknowledgeTaskWorkerResume({
              requestId: 'manual_resume', waitId: probe.waitId, value: { source: 'fixture-manual' }
            }, ack), true);
          } catch (error) { fail(error); }
        }, 650);
      }
    }
  });
  if (callbackFailure) throw callbackFailure;
  assert.equal(result.state, 'finished');
  assert.equal(result.result.title, 'Ready fixture');
  assert.equal(browserClosed, true);
  assert.equal(resumedCount, 1);
  assert.equal(pausedBeforeFinalScreenshot, true);
  assert.equal(waiting.pauseAfterMs, injectedTiming.pauseAfterMs);
  assert.equal(waiting.probeIntervalMs, injectedTiming.probeIntervalMs);
  assert.equal(waiting.automaticPaused, false);
  assert.equal(probes.length, 4);
  assert.ok(probes.every((probe) => probe.screenshotPath));
  for (const probe of probes) {
    const bytes = await readFile(probe.screenshotPath);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  const report = {
    ok: true, fixtureOnly: true, injectedTiming,
    productionClockTest: 'test-v3/verification-wait.test.mjs',
    productionNotificationClockTest: 'test-v3/desktop-notifications.test.mjs',
    productionTiming: { probeIntervalMs: 300_000, pauseAfterMs: 1_200_000, notificationIntervalMs: 30_000 },
    timingEvidence: 'Live Chrome uses injected short timings; unit clocks cover production 5/10/15/20-minute probes and 30-second notifications.',
    screenshots: probes.map((probe) => probe.screenshotPath),
    automaticPause: pauses[0], pausedBeforeFinalScreenshot,
    finalScreenshotDiagnosticOnly: probes.at(-1).needsAgentDecision === false,
    acknowledgements, manualResumeConfirmed: resumedCount === 1,
    heartbeatCount, heartbeatsAfterPause: heartbeatCount - heartbeatsAtPause,
    browserClosed, finalTitle: result.result.title
  };
  await writeFile(path.join(reportDir, 'acceptance.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  clearTimeout(verifyHold);
  clearTimeout(acceptanceTimeout);
  controller.abort();
  await context?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  const usage = await probeChromeProfileUsage(profilePath);
  assert.equal(usage, 'inactive', 'Only remove the isolated fixture Profile after Chrome exits');
  assert.equal(path.dirname(root), os.tmpdir());
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
