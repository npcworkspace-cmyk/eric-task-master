#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createActionArbiter } from '../src/lib/action-arbiter.mjs';
import { inspectEffectJournal } from '../src/lib/effect-journal.mjs';
import {
  createExtensionActionCoordinator,
  EXTENSION_ACTION_PROTOCOL
} from '../src/lib/extension-action-coordinator.mjs';
import { resolveBrowserEngine } from '../src/runtime/browser-engine.mjs';
import { runTaskWorker } from '../src/runtime/task-worker.mjs';

const COMMAND_EVENT = 'taskmaster-acceptance:extension-command-v2';
const TRACE_ATTRIBUTE = 'data-taskmaster-acceptance-trace';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCoordinatorAudit(coordinator, predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let audit = coordinator.audit();
  while (!predicate(audit) && Date.now() < deadline) {
    await delay(10);
    audit = coordinator.audit();
  }
  assert.equal(predicate(audit), true, `${description}; observed ${JSON.stringify(audit)}`);
  return audit;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function extensionContentSource() {
  const protocol = JSON.stringify(EXTENSION_ACTION_PROTOCOL);
  return `(() => {
    const protocol = ${protocol};
    const commandEvent = ${JSON.stringify(COMMAND_EVENT)};
    const traceAttribute = ${JSON.stringify(TRACE_ATTRIBUTE)};
    const pending = new Map();
    const running = new Set();
    const completed = new Set();
    const manualFinishes = new Map();

    function root() {
      return document.documentElement;
    }

    function readTrace() {
      try {
        return JSON.parse(root()?.getAttribute(traceAttribute) || '[]');
      } catch {
        return [];
      }
    }

    function trace(label) {
      const element = root();
      if (!element) return;
      const entries = readTrace();
      entries.push({ label: String(label).slice(0, 80), at: performance.now() });
      element.setAttribute(traceAttribute, JSON.stringify(entries.slice(-100)));
    }

    function markReady() {
      const element = root();
      if (!element) {
        setTimeout(markReady, 0);
        return;
      }
      element.dataset.taskmasterAcceptanceExtension = 'active';
      chrome.runtime.sendMessage({ kind: 'acceptance-ready' }).then((response) => {
        if (response?.ok === true) {
          element.dataset.taskmasterAcceptanceServiceWorker = 'ready';
          element.dataset.taskmasterAcceptanceCapabilities = Array.isArray(response.capabilities)
            ? response.capabilities.join(',')
            : 'missing';
        }
      }).catch(() => {});
    }

    document.addEventListener(protocol.grantEvent, (event) => {
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
      const participantId = String(detail.participantId || '').slice(0, 80);
      const requestId = String(detail.requestId || '').slice(0, 80);
      const jobKey = participantId + '\\u0000' + requestId;
      const job = pending.get(jobKey);
      if (!job) return;
      if (detail.ok !== true || !detail.leaseId) {
        trace(job.label + ':rejected');
        pending.delete(job.key);
        return;
      }
      if (completed.has(job.key) || running.has(job.key)) return;
      running.add(job.key);
      trace(job.label + ':start');
      const target = document.querySelector(job.target);
      if (job.kind === 'input') {
        target.value = job.value;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        trace(job.label + ':input');
      } else if (job.kind === 'mutate') {
        target.textContent = job.value;
        trace(job.label + ':mutation');
      } else if (job.kind === 'compound') {
        const input = document.querySelector('#extension-input');
        const box = document.querySelector('#extension-box');
        input.value = job.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        trace(job.label + ':input');
        box.textContent = job.value;
        trace(job.label + ':mutation');
        target?.click();
      } else if (job.kind === 'navigate') {
        setTimeout(() => {
          trace(job.label + ':navigation');
          location.href = job.url;
        }, Math.max(20, job.holdMs));
        return;
      } else {
        target?.click();
      }
      const finish = () => {
        trace(job.label + ':end');
        document.dispatchEvent(new CustomEvent(protocol.releaseEvent, {
           detail: {
             participantId: job.participantId,
             leaseId: detail.leaseId,
             outcome: {
               status: 'succeeded',
               code: 'acceptance-' + job.kind + '-complete',
               facts: ['visible-state-applied']
             }
           }
         }));
        running.delete(job.key);
        completed.add(job.key);
        pending.delete(job.key);
        manualFinishes.delete(job.key);
      };
      if (job.kind === 'held' || job.manualRelease) manualFinishes.set(job.key, finish);
      else if (job.holdMs > 0) setTimeout(finish, job.holdMs);
      else finish();
    }, true);

    document.addEventListener(commandEvent, (event) => {
      const command = event?.detail && typeof event.detail === 'object' ? event.detail : {};
      const label = String(command.label || 'extension').slice(0, 60);
      const target = String(command.target || '#extension-button').slice(0, 100);
      const kind = String(command.kind || 'click');
      if (kind === 'unintegrated-click') {
        trace(label + ':start');
        document.querySelector(target)?.click();
        trace(label + ':end');
        return;
      }
      const requestId = String(command.requestId || label).replace(/[^a-z0-9._:-]/gi, '-').slice(0, 64);
      const participantId = String(command.participantId || 'acceptance-extension')
        .replace(/[^a-z0-9._:-]/gi, '-').slice(0, 64);
      const jobKey = participantId + '\\u0000' + requestId;
      if (String(command.kind || '') === 'release-held') {
        manualFinishes.get(jobKey)?.();
        return;
      }
      const job = {
        label,
        target,
        requestId,
        participantId,
        key: jobKey,
        holdMs: Math.max(0, Math.min(2_000, Number(command.holdMs) || 0)),
        blockMs: Math.max(0, Math.min(2_000, Number(command.blockMs) || 0)),
        durationMs: Number.isFinite(Number(command.durationMs)) && Number(command.durationMs) > 0
          ? Math.max(250, Math.min(10_000, Number(command.durationMs)))
          : 0,
        manualRelease: command.manualRelease === true,
        kind,
        value: String(command.value || 'extension-value').slice(0, 200),
        url: String(command.url || location.href)
      };
      pending.set(jobKey, job);
      document.dispatchEvent(new CustomEvent(protocol.requestEvent, {
        detail: {
          participantId,
          requestId,
          operation: 'acceptance-' + job.kind,
          durationMs: job.durationMs || (job.kind === 'navigate' ? 5_000 : Math.max(2_000, job.holdMs + 2_000))
        }
      }));
      if (command.duplicate === true) {
        document.dispatchEvent(new CustomEvent(protocol.requestEvent, {
          detail: {
            participantId,
            requestId,
            operation: 'acceptance-' + job.kind,
            durationMs: Math.max(2_000, job.holdMs + 2_000)
          }
        }));
      }
      if (job.blockMs > 0) {
        const blockedUntil = performance.now() + job.blockMs;
        while (performance.now() < blockedUntil) {
          // Intentionally block this renderer for the stale-grant acceptance.
        }
      }
    }, true);

    markReady();
  })();\n`;
}

function fixtureHtml() {
  return `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Task Master extension serialization acceptance</title></head>
      <body>
        <button id="task-button">Task action</button>
        <button id="extension-button">Extension action</button>
        <button id="page-primary">Page primary</button>
        <button id="page-secondary">Page secondary</button>
        <input id="extension-input" value="initial">
        <div id="extension-box">initial</div>
        <iframe id="acceptance-frame" src="/frame"></iframe>
        <output id="task-count">0</output>
        <output id="extension-count">0</output>
        <output id="page-secondary-count">0</output>
        <script>
          function appendAcceptanceTrace(label) {
            const attribute = ${JSON.stringify(TRACE_ATTRIBUTE)};
            let entries;
            try {
              entries = JSON.parse(document.documentElement.getAttribute(attribute) || '[]');
            } catch {
              entries = [];
            }
            entries.push({ label, at: performance.now() });
            document.documentElement.setAttribute(attribute, JSON.stringify(entries.slice(-100)));
          }
          for (const [buttonId, outputId] of [
            ['task-button', 'task-count'],
            ['extension-button', 'extension-count']
          ]) {
            document.getElementById(buttonId).addEventListener('click', () => {
              appendAcceptanceTrace(buttonId + ':click');
              const output = document.getElementById(outputId);
              output.textContent = String(Number(output.textContent) + 1);
            });
          }
          document.getElementById('page-primary').addEventListener('click', () => {
            document.getElementById('page-secondary').click();
          });
          document.getElementById('page-secondary').addEventListener('click', () => {
            const output = document.getElementById('page-secondary-count');
            output.textContent = String(Number(output.textContent) + 1);
          });
          if (['cooperative-first', 'cooperative-unresolved'].includes(
            new URL(location.href).searchParams.get('worker')
          )) {
            setTimeout(() => document.dispatchEvent(new CustomEvent(${JSON.stringify(COMMAND_EVENT)}, {
              detail: {
                label: 'worker-extension',
                requestId: 'worker-extension',
                kind: 'compound',
                value: 'worker-extension-value',
                holdMs: 0
              }
            })), 50);
          }
        </script>
      </body>
    </html>`;
}

function frameFixtureHtml() {
  return `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Extension frame</title></head>
      <body>
        <button id="extension-button">Frame extension action</button>
        <input id="extension-input" value="initial">
        <div id="extension-box">initial</div>
        <output id="extension-count">0</output>
        <script>
          document.getElementById('extension-button').addEventListener('click', () => {
            const output = document.getElementById('extension-count');
            output.textContent = String(Number(output.textContent) + 1);
          });
        </script>
      </body>
    </html>`;
}

async function appendTrace(page, label) {
  await page.evaluate(({ attribute, label: entryLabel }) => {
    let entries;
    try {
      entries = JSON.parse(document.documentElement.getAttribute(attribute) || '[]');
    } catch {
      entries = [];
    }
    entries.push({ label: entryLabel, at: performance.now() });
    document.documentElement.setAttribute(attribute, JSON.stringify(entries.slice(-100)));
  }, { attribute: TRACE_ATTRIBUTE, label });
}

async function readTrace(page) {
  return page.evaluate((attribute) => {
    try {
      return JSON.parse(document.documentElement.getAttribute(attribute) || '[]');
    } catch {
      return [];
    }
  }, TRACE_ATTRIBUTE);
}

async function clearTrace(page) {
  await page.evaluate((attribute) => document.documentElement.setAttribute(attribute, '[]'), TRACE_ATTRIBUTE);
}

async function waitForTrace(page, label, timeout = 5_000) {
  try {
    await page.waitForFunction(({ attribute, label: expected }) => {
      try {
        return JSON.parse(document.documentElement.getAttribute(attribute) || '[]')
          .some((entry) => entry.label === expected);
      } catch {
        return false;
      }
    }, { attribute: TRACE_ATTRIBUTE, label }, { timeout });
  } catch (error) {
    const observed = await readTrace(page).catch(() => []);
    error.message = `${error.message} Waiting for ${label}; observed ${JSON.stringify(labels(observed))}`;
    throw error;
  }
}

async function dispatchExtensionCommand(page, command) {
  await page.evaluate(({ eventName, detail }) => {
    document.dispatchEvent(new CustomEvent(eventName, { detail }));
  }, { eventName: COMMAND_EVENT, detail: command });
}

function labels(trace) {
  return trace.map((entry) => entry.label);
}

function assertOrdered(trace, expected) {
  const observed = labels(trace);
  let previous = -1;
  for (const label of expected) {
    const index = observed.findIndex((entry, entryIndex) => entryIndex > previous && entry === label);
    assert.ok(index > previous, `${label} was not ordered after the preceding event`);
    previous = index;
  }
}

async function writeOptionalReport(report, reportPath) {
  if (!reportPath) return;
  const target = path.resolve(reportPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' });
}

export async function runExtensionAcceptance({
  reportPath = process.env.TASKMASTER_EXTENSION_REPORT || null
} = {}) {
  const startedAt = new Date();
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-extension-acceptance-'));
  const extensionDir = path.join(root, 'mv3-extension');
  const profileDir = path.join(root, 'persistent-profile');
  const checks = [];
  let server = null;
  let context = null;
  let coordinator = null;

  const record = (name, evidence = {}) => {
    checks.push({ name, ok: true, evidence });
  };

  try {
    await mkdir(extensionDir, { recursive: true });
    await writeFile(path.join(extensionDir, 'manifest.json'), `${JSON.stringify({
      manifest_version: 3,
      name: 'Task Master MV3 serialization acceptance',
      version: '1.0.0',
       background: { service_worker: 'background.js' },
       permissions: ['storage', 'tabs', 'scripting'],
       host_permissions: ['http://127.0.0.1/*'],
       content_scripts: [{
        matches: ['http://127.0.0.1/*'],
        js: ['content.js'],
        run_at: 'document_start',
        all_frames: true
      }]
    }, null, 2)}\n`);
    await writeFile(path.join(extensionDir, 'background.js'), [
      "chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {",
      "  if (message?.kind !== 'acceptance-ready') return false;",
      '  (async () => {',
      "    const tabId = sender.tab?.id;",
      "    if (!Number.isInteger(tabId)) throw new Error('sender tab is unavailable');",
      "    await chrome.storage.local.set({ taskmasterAcceptance: 'ready' });",
      "    const stored = await chrome.storage.local.get('taskmasterAcceptance');",
      "    const declaredPermissions = await chrome.permissions.contains({ permissions: ['storage', 'tabs', 'scripting'] });",
      "    const declaredOrigin = await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] });",
      "    const probeTab = await chrome.tabs.create({ url: 'about:blank', active: false });",
      '    const protectedTab = await chrome.tabs.get(probeTab.id);',
      '    await chrome.tabs.remove(probeTab.id);',
      '    const execution = await chrome.scripting.executeScript({',
      '      target: { tabId },',
      '      func: () => location.protocol',
      '    });',
      "    const capabilities = [];",
      "    if (declaredPermissions && stored.taskmasterAcceptance === 'ready') capabilities.push('storage');",
      "    if (declaredPermissions && protectedTab?.url === 'about:blank') capabilities.push('tabs');",
      "    if (declaredPermissions && execution?.[0]?.result === 'http:') capabilities.push('scripting');",
      "    if (declaredOrigin) capabilities.push('host-permissions');",
      '    sendResponse({ ok: capabilities.length === 4, capabilities });',
      '  })().catch(() => sendResponse({ ok: false, capabilities: [] }));',
      '  return true;',
      '});',
      ''
    ].join('\n'));
    await writeFile(path.join(extensionDir, 'content.js'), extensionContentSource());

    server = createServer((request, response) => {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(request.url?.startsWith('/frame') ? frameFixtureHtml() : fixtureHtml());
    });
    await listen(server);
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/acceptance`;
    const extensionArgs = [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`
    ];
    const enabled = resolveBrowserEngine({ chromium }, {
      kind: 'persistent',
      browserEngine: 'chromium',
      headless: false,
      extensionsEnabled: true
    });
    assert.deepEqual(enabled.launchOptions.ignoreDefaultArgs, ['--disable-extensions']);
    context = await enabled.browserType.launchPersistentContext(profileDir, {
      ...enabled.launchOptions,
      headless: false,
      args: extensionArgs
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (
      document.documentElement.dataset.taskmasterAcceptanceExtension === 'active' &&
      document.documentElement.dataset.taskmasterAcceptanceServiceWorker === 'ready' &&
      document.documentElement.dataset.taskmasterAcceptanceCapabilities ===
        'storage,tabs,scripting,host-permissions'
    ));
    await page.locator('#acceptance-frame').waitFor();
    const acceptanceFrame = page.frames().find((frame) => {
      try { return new URL(frame.url()).pathname === '/frame'; } catch { return false; }
    });
    assert.ok(acceptanceFrame, 'the pre-existing acceptance iframe must be loaded');
    await acceptanceFrame.waitForFunction(() => (
      document.documentElement.dataset.taskmasterAcceptanceExtension === 'active'
    ));
    coordinator = await createExtensionActionCoordinator({
      context,
      page,
      enabled: true,
      taskWaitMs: 3_000,
      extensionWaitMs: 3_000,
      extensionLeaseMs: 1_500
    });
    assert.ok(context.serviceWorkers().some((worker) => worker.url().startsWith('chrome-extension://')));
    record('mv3-content-script-and-service-worker-loaded', {
      serviceWorkers: context.serviceWorkers().filter((worker) => worker.url().startsWith('chrome-extension://')).length,
      chromeApis: ['storage', 'tabs', 'scripting', 'host-permissions']
    });

    await clearTrace(page);
    await dispatchExtensionCommand(page, {
      label: 'extension-first',
      requestId: 'extension-first',
      kind: 'compound',
      value: 'extension-first-value',
      manualRelease: true,
      durationMs: 10_000
    });
    await waitForTrace(page, 'extension-first:start');
    const taskAfterExtension = coordinator.run('task-after-extension', async () => {
      await appendTrace(page, 'task-after-extension:start');
      await page.locator('#task-button').click();
      await appendTrace(page, 'task-after-extension:end');
    });
    assert.equal(coordinator.audit().active, 1);
    assert.equal(coordinator.audit().pending, 1);
    await dispatchExtensionCommand(page, {
      label: 'extension-first-release',
      requestId: 'extension-first',
      kind: 'release-held'
    });
    await taskAfterExtension;
    const extensionFirstTrace = await readTrace(page);
    assertOrdered(extensionFirstTrace, [
      'extension-first:start',
      'extension-first:input',
      'extension-first:mutation',
      'extension-first:end',
      'task-after-extension:start',
      'task-after-extension:end'
    ]);
    assert.equal(await page.locator('#extension-input').inputValue(), 'extension-first-value');
    assert.equal(await page.locator('#extension-box').textContent(), 'extension-first-value');
    record('cooperative-extension-lease-blocks-task', {
      order: labels(extensionFirstTrace),
      input: 'extension-first-value',
      mutation: 'extension-first-value'
    });

    await clearTrace(page);
    const extensionCountBeforeParticipantCollision = Number(await page.locator('#extension-count').textContent());
    await coordinator.run('participant-grant-collision-holder', async () => {
      await dispatchExtensionCommand(page, {
        label: 'participant-a',
        participantId: 'acceptance-extension-a',
        requestId: 'shared-request-id',
        kind: 'held',
        durationMs: 10_000,
        holdMs: 0
      });
      await dispatchExtensionCommand(page, {
        label: 'participant-b',
        participantId: 'acceptance-extension-b',
        requestId: 'shared-request-id',
        kind: 'click',
        holdMs: 0
      });
      await waitForCoordinatorAudit(
        coordinator,
        (audit) => audit.active === 1 && audit.pending === 2,
        'both participants must wait behind the Task lease before either grant is broadcast'
      );
    });
    await waitForTrace(page, 'participant-a:start');
    assert.equal(coordinator.audit().active, 1);
    assert.equal(coordinator.audit().pending, 1);
    assert.equal(labels(await readTrace(page)).includes('participant-b:start'), false);
    await dispatchExtensionCommand(page, {
      label: 'participant-a-release',
      participantId: 'acceptance-extension-a',
      requestId: 'shared-request-id',
      kind: 'release-held'
    });
    await waitForTrace(page, 'participant-b:end');
    const participantCollisionTrace = await readTrace(page);
    assertOrdered(participantCollisionTrace, [
      'participant-a:start',
      'participant-a:end',
      'participant-b:start',
      'participant-b:end'
    ]);
    const extensionCountAfterParticipantCollision = Number(await page.locator('#extension-count').textContent());
    assert.equal(extensionCountAfterParticipantCollision - extensionCountBeforeParticipantCollision, 2);
    record('participant-scoped-request-ids-cannot-cross-grant-leases', {
      sharedRequestId: true,
      extensionActions: 2,
      order: labels(participantCollisionTrace)
    });

    await clearTrace(acceptanceFrame);
    await dispatchExtensionCommand(acceptanceFrame, {
      label: 'existing-frame-extension',
      requestId: 'existing-frame-extension',
      kind: 'held',
      durationMs: 10_000
    });
    await waitForTrace(acceptanceFrame, 'existing-frame-extension:start');
    let taskAfterFrameNavigationStarted = false;
    const taskAfterFrameNavigation = coordinator.run('task-after-source-frame-destroyed', async () => {
      taskAfterFrameNavigationStarted = true;
      await page.locator('#task-button').click();
    });
    assert.equal(coordinator.audit().pending, 1);
    assert.equal(taskAfterFrameNavigationStarted, false);
    const releasesBeforeFrameNavigation = coordinator.audit().navigationReleases;
    await page.goto(`${url}?frame-destroyed=1`, { waitUntil: 'domcontentloaded' });
    await taskAfterFrameNavigation;
    assert.equal(taskAfterFrameNavigationStarted, true);
    assert.equal(coordinator.audit().navigationReleases > releasesBeforeFrameNavigation, true);
    record('pre-existing-iframe-is-coordinated-and-top-navigation-releases-it', {
      taskBlockedBeforeNavigation: true,
      navigationReleases: coordinator.audit().navigationReleases
    });

    const unrelatedPage = await context.newPage();
    await unrelatedPage.goto(`${url}?unrelated=1`, { waitUntil: 'domcontentloaded' });
    await unrelatedPage.waitForFunction(() => (
      document.documentElement.dataset.taskmasterAcceptanceExtension === 'active'
    ));
    await clearTrace(page);
    await dispatchExtensionCommand(page, {
      label: 'main-page-holder',
      requestId: 'main-page-holder',
      kind: 'held',
      durationMs: 10_000
    });
    await waitForTrace(page, 'main-page-holder:start');
    let unrelatedNavigationTaskStarted = false;
    const unrelatedNavigationTask = coordinator.run('task-after-unrelated-navigation', async () => {
      unrelatedNavigationTaskStarted = true;
    });
    const releasesBeforeUnrelatedNavigation = coordinator.audit().navigationReleases;
    const unrelatedNavigation = unrelatedPage.goto(`${url}?unrelated=2`, { waitUntil: 'domcontentloaded' });
    await unrelatedNavigation;
    assert.equal(unrelatedNavigationTaskStarted, false);
    assert.equal(coordinator.audit().pending, 1);
    assert.equal(coordinator.audit().navigationReleases, releasesBeforeUnrelatedNavigation);
    await dispatchExtensionCommand(page, {
      label: 'main-page-holder-release',
      requestId: 'main-page-holder',
      kind: 'release-held'
    });
    await unrelatedNavigationTask;

    await dispatchExtensionCommand(unrelatedPage, {
      label: 'source-page-close',
      requestId: 'source-page-close',
      kind: 'held',
      durationMs: 10_000
    });
    await waitForTrace(unrelatedPage, 'source-page-close:start');
    let taskAfterSourceCloseStarted = false;
    const taskAfterSourceClose = coordinator.run('task-after-source-page-close', async () => {
      taskAfterSourceCloseStarted = true;
    });
    assert.equal(coordinator.audit().pending, 1);
    assert.equal(taskAfterSourceCloseStarted, false);
    const sourceCloseStartedAt = Date.now();
    await unrelatedPage.close();
    await taskAfterSourceClose;
    const sourceCloseWaitMs = Date.now() - sourceCloseStartedAt;
    assert.equal(taskAfterSourceCloseStarted, true);
    record('unrelated-tab-navigation-does-not-release-source-but-source-close-does', {
      unrelatedNavigationReleased: false,
      sourceCloseWaitMs
    });

    await clearTrace(page);
    await coordinator.run('task-first', async () => {
      await appendTrace(page, 'task-first:start');
      await dispatchExtensionCommand(page, {
        label: 'extension-after-task',
        requestId: 'extension-after-task',
        kind: 'input',
        target: '#extension-input',
        value: 'extension-after-task-value',
        holdMs: 40
      });
      await waitForCoordinatorAudit(
        coordinator,
        (audit) => audit.active === 1 && audit.pending === 1,
        'the extension action must be queued behind the active Task lease'
      );
      await page.locator('#task-button').click();
      await appendTrace(page, 'task-first:end');
    });
    await waitForTrace(page, 'extension-after-task:end');
    const taskFirstTrace = await readTrace(page);
    assertOrdered(taskFirstTrace, [
      'task-first:start',
      'task-first:end',
      'extension-after-task:start',
      'extension-after-task:end'
    ]);
    record('task-lease-blocks-cooperative-extension', {
      order: labels(taskFirstTrace)
    });

    await clearTrace(page);
    const arbiter = createActionArbiter();
    let activeTaskActions = 0;
    let maximumTaskActions = 0;
    const runTaskAction = (name, holdMs) => arbiter.run(name, () => coordinator.run(name, async () => {
      activeTaskActions += 1;
      maximumTaskActions = Math.max(maximumTaskActions, activeTaskActions);
      await appendTrace(page, `${name}:start`);
      await delay(holdMs);
      await page.locator('#task-button').click();
      await appendTrace(page, `${name}:end`);
      activeTaskActions -= 1;
    }));
    await Promise.all([
      runTaskAction('task-fifo-one', 100),
      runTaskAction('task-fifo-two', 10)
    ]);
    const fifoTrace = await readTrace(page);
    assertOrdered(fifoTrace, [
      'task-fifo-one:start',
      'task-fifo-one:end',
      'task-fifo-two:start',
      'task-fifo-two:end'
    ]);
    assert.equal(maximumTaskActions, 1);
    assert.equal(arbiter.audit().serialized, true);
    assert.equal(arbiter.audit().maximumActive, 1);
    record('task-actions-are-strict-fifo', {
      order: labels(fifoTrace),
      maximumActive: maximumTaskActions,
      maximumQueueDepth: arbiter.audit().maximumQueueDepth
    });

    const workerModulePath = path.join(root, 'extension-worker-task.mjs');
    const workerOutputDir = path.join(root, 'extension-worker-output');
    const workerCheckpointPath = path.join(root, 'extension-worker-state', 'checkpoint.json');
    const workerProfileDir = path.join(root, 'extension-worker-profile');
    await writeFile(workerModulePath, [
      "import { writeFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      'export async function run({ page, journey, extensionFlow, input, outputDir, checkpoint }) {',
      "  const completion = extensionFlow.expectCompletion({ participantId: 'acceptance-extension', requestId: 'worker-extension', operation: 'acceptance-compound', timeoutMs: 5_000 });",
      '  await journey.open(input.url);',
      '  const receipt = await completion;',
      "  const extensionState = { input: await page.locator('#extension-input').inputValue(), box: await page.locator('#extension-box').textContent(), count: Number(await page.locator('#extension-count').textContent()) };",
      "  const verified = receipt.outcome.status === 'succeeded' && receipt.outcome.code === 'acceptance-compound-complete' && extensionState.input === 'worker-extension-value' && extensionState.box === 'worker-extension-value' && extensionState.count === 1;",
      "  if (!verified) await extensionFlow.resolveCompletion(receipt.receiptId, { decision: 'rejected', code: 'page-state-mismatch' });",
      "  const firstTaskClick = journey.click('#task-button');",
      '  firstTaskClick.catch(() => {});',
      "  const taskCountBeforeTakeover = Number(await page.locator('#task-count').textContent());",
      "  if (taskCountBeforeTakeover !== 0) throw new Error('Task action escaped the extension completion gate');",
      "  await checkpoint({ stage: 'extension-verified', participantId: receipt.participantId, requestId: receipt.requestId, operation: receipt.operation, outcome: receipt.outcome, extensionState });",
      "  const resolution = await extensionFlow.resolveCompletion(receipt.receiptId, { decision: 'verified', code: 'page-state-verified' });",
      '  await firstTaskClick;',
      "  await journey.click('#task-button');",
      "  const finalExtensionState = { input: await page.locator('#extension-input').inputValue(), box: await page.locator('#extension-box').textContent(), count: Number(await page.locator('#extension-count').textContent()) };",
      "  if (JSON.stringify(finalExtensionState) !== JSON.stringify(extensionState)) throw new Error('Task action overwrote extension-owned state');",
      `  const trace = JSON.parse(await page.locator('html').getAttribute(${JSON.stringify(TRACE_ATTRIBUTE)}) || '[]');`,
      "  const counts = await page.locator('output').allTextContents();",
      "  await writeFile(path.join(outputDir, 'worker-trace.json'), JSON.stringify({ trace, counts, receipt, resolution, extensionState, finalExtensionState, taskCountBeforeTakeover }, null, 2));",
      "  return { summary: 'Worker Journey and extension actions completed in one serialized browser.', evidence: [{ kind: 'artifact', file: 'worker-trace.json', agentVisible: true }] };",
      '}',
      ''
    ].join('\n'));
    const workerOutcome = await runTaskWorker({
      taskId: 'task_extension_worker_acceptance',
      attempt: 1,
      modulePath: workerModulePath,
      outputDir: workerOutputDir,
      checkpointPath: workerCheckpointPath,
      input: { url: `${url}?worker=cooperative-first` },
      behavior: 'fast',
      interactionContract: 'full-human-v1',
      profile: {
        kind: 'persistent',
        browserEngine: 'chromium',
        userDataDir: workerProfileDir,
        headless: false,
        extensionsEnabled: true
      },
      heartbeatMs: 1_000,
      timeoutMs: 30_000
    }, {
      loadPlaywright: async () => ({
        chromium: {
          launchPersistentContext(userDataDir, options) {
            return chromium.launchPersistentContext(userDataDir, {
              ...options,
              args: [...(options.args || []), ...extensionArgs]
            });
          }
        }
      })
    });
    assert.equal(workerOutcome.state, 'completed', JSON.stringify(workerOutcome));
    const workerEvidence = JSON.parse(await readFile(path.join(workerOutputDir, 'worker-trace.json'), 'utf8'));
    assertOrdered(workerEvidence.trace, [
      'worker-extension:start',
      'worker-extension:input',
      'worker-extension:mutation',
      'extension-button:click',
      'worker-extension:end',
      'task-button:click',
      'task-button:click'
    ]);
    assert.deepEqual(workerEvidence.counts, ['2', '1', '0']);
    assert.equal(workerEvidence.taskCountBeforeTakeover, 0);
    assert.equal(workerEvidence.receipt.participantId, 'acceptance-extension');
    assert.equal(workerEvidence.receipt.requestId, 'worker-extension');
    assert.equal(workerEvidence.receipt.operation, 'acceptance-compound');
    assert.equal(workerEvidence.receipt.outcome.status, 'succeeded');
    assert.equal(workerEvidence.resolution.decision, 'verified');
    assert.deepEqual(workerEvidence.extensionState, {
      input: 'worker-extension-value',
      box: 'worker-extension-value',
      count: 1
    });
    assert.deepEqual(workerEvidence.finalExtensionState, workerEvidence.extensionState);
    const workerCheckpoint = JSON.parse(await readFile(workerCheckpointPath, 'utf8'));
    assert.equal(workerCheckpoint.extensionHandoff.receiptId, workerEvidence.receipt.receiptId);
    assert.equal(workerCheckpoint.extensionHandoff.participantId, 'acceptance-extension');
    assert.equal(workerCheckpoint.extensionHandoff.requestId, 'worker-extension');
    assert.equal(workerCheckpoint.extensionHandoff.operation, 'acceptance-compound');
    assert.equal(workerCheckpoint.data.stage, 'extension-verified');
    assert.deepEqual(workerCheckpoint.data.extensionState, workerEvidence.extensionState);
    const interactionAudit = JSON.parse(await readFile(path.join(workerOutputDir, 'interaction-audit.json'), 'utf8'));
    assert.equal(interactionAudit.passed, true);
    assert.equal(interactionAudit.coordination.maximumActive, 1);
    assert.equal(interactionAudit.coordination.serialized, true);
    assert.equal(interactionAudit.coordination.extension.serialized, true);
    record('real-worker-extension-handoff-gates-task-takeover', {
      order: labels(workerEvidence.trace),
      taskClicks: 2,
      extensionClicks: 1,
      taskCountBeforeTakeover: workerEvidence.taskCountBeforeTakeover,
      receiptIdentity: [
        workerEvidence.receipt.participantId,
        workerEvidence.receipt.requestId,
        workerEvidence.receipt.operation
      ],
      extensionOutcome: workerEvidence.receipt.outcome,
      taskResolution: workerEvidence.resolution,
      checkpointLinkedReceipt: workerCheckpoint.extensionHandoff.receiptId,
      extensionStatePreserved: true,
      maximumActive: interactionAudit.coordination.maximumActive
    });

    const workerEffectJournalPath = path.join(
      path.dirname(workerCheckpointPath),
      'effect-journal.jsonl'
    );
    const workerEffectJournal = await inspectEffectJournal(workerEffectJournalPath);
    assert.deepEqual(workerEffectJournal.pending, []);
    const workerEffectRecords = (await readFile(workerEffectJournalPath, 'utf8'))
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(workerEffectRecords.some((entry) => (
      entry.state === 'started' && entry.operation === 'custom'
    )), true);
    assert.equal(workerEffectRecords.some((entry) => (
      entry.state === 'succeeded' && entry.operation === 'custom'
    )), true);

    const unresolvedTaskId = 'task_extension_unresolved_acceptance';
    const unresolvedModulePath = path.join(root, 'extension-unresolved-task.mjs');
    const unresolvedRecoveryModulePath = path.join(root, 'extension-unresolved-recovery-task.mjs');
    const unresolvedOutputDir = path.join(root, 'extension-unresolved-output');
    const unresolvedRecoveryOutputDir = path.join(root, 'extension-unresolved-recovery-output');
    const unresolvedCheckpointPath = path.join(root, 'extension-unresolved-state', 'checkpoint.json');
    const unresolvedProfileDir = path.join(root, 'extension-unresolved-profile');
    await writeFile(unresolvedModulePath, [
      'export async function run({ journey, extensionFlow, input, checkpoint }) {',
      "  await checkpoint({ stage: 'before-extension' });",
      "  const completion = extensionFlow.expectCompletion({ participantId: 'acceptance-extension', requestId: 'worker-extension', operation: 'acceptance-compound', timeoutMs: 5_000 });",
      '  await journey.open(input.url);',
      '  await completion;',
      "  const error = new Error('Acceptance verification crashed after the extension completed');",
      "  error.code = 'ACCEPTANCE_EXTENSION_VERIFICATION_CRASH';",
      '  throw error;',
      '}',
      ''
    ].join('\n'));
    const unresolvedOutcome = await runTaskWorker({
      taskId: unresolvedTaskId,
      attempt: 1,
      modulePath: unresolvedModulePath,
      outputDir: unresolvedOutputDir,
      checkpointPath: unresolvedCheckpointPath,
      input: { url: `${url}?worker=cooperative-unresolved` },
      behavior: 'fast',
      interactionContract: 'full-human-v1',
      profile: {
        kind: 'persistent',
        browserEngine: 'chromium',
        userDataDir: unresolvedProfileDir,
        headless: false,
        extensionsEnabled: true
      },
      heartbeatMs: 1_000,
      timeoutMs: 30_000
    }, {
      loadPlaywright: async () => ({
        chromium: {
          launchPersistentContext(userDataDir, options) {
            return chromium.launchPersistentContext(userDataDir, {
              ...options,
              args: [...(options.args || []), ...extensionArgs]
            });
          }
        }
      })
    });
    assert.equal(unresolvedOutcome.state, 'failed', JSON.stringify(unresolvedOutcome));
    const unresolvedJournalPath = path.join(
      path.dirname(unresolvedCheckpointPath),
      'effect-journal.jsonl'
    );
    const unresolvedJournal = await inspectEffectJournal(unresolvedJournalPath, { includeMetadata: true });
    assert.equal(unresolvedJournal.pending.length, 1);
    assert.equal(unresolvedJournal.pending[0].operation, 'custom');
    const unresolvedCheckpointBytes = await readFile(unresolvedCheckpointPath);
    const unresolvedCheckpoint = JSON.parse(unresolvedCheckpointBytes.toString('utf8'));
    assert.equal(unresolvedCheckpoint.data.stage, 'before-extension');
    assert.equal(Object.hasOwn(unresolvedCheckpoint, 'extensionHandoff'), false);
    const frozenResumePath = path.join(root, 'extension-unresolved-state', 'resume-input-attempt-2.json');
    await writeFile(frozenResumePath, unresolvedCheckpointBytes);
    await writeFile(unresolvedRecoveryModulePath, [
      'export async function run({ journey, input, checkpoint, effects }) {',
      '  const restored = await checkpoint.read();',
      "  if (restored?.stage !== 'before-extension') throw new Error('Frozen resume checkpoint mismatch');",
      "  if (effects.pending().length !== 1) throw new Error('Expected one unresolved extension effect');",
      '  await journey.open(input.url);',
      "  return { summary: 'must not replay unresolved extension effect', evidence: [] };",
      '}',
      ''
    ].join('\n'));
    const unresolvedResumeOutcome = await runTaskWorker({
      taskId: unresolvedTaskId,
      attempt: 2,
      modulePath: unresolvedRecoveryModulePath,
      outputDir: unresolvedRecoveryOutputDir,
      checkpointPath: unresolvedCheckpointPath,
      resumeCheckpoint: {
        path: frozenResumePath,
        sourceAttempt: 1,
        targetAttempt: 2,
        savedAt: unresolvedCheckpoint.savedAt,
        sha256: createHash('sha256').update(unresolvedCheckpointBytes).digest('hex'),
        sizeBytes: unresolvedCheckpointBytes.byteLength
      },
      input: { url: `${url}?worker=cooperative-resume-must-not-open` },
      behavior: 'fast',
      interactionContract: 'full-human-v1',
      profile: {
        kind: 'persistent',
        browserEngine: 'chromium',
        userDataDir: unresolvedProfileDir,
        headless: false,
        extensionsEnabled: true
      },
      heartbeatMs: 1_000,
      timeoutMs: 30_000
    }, {
      loadPlaywright: async () => ({
        chromium: {
          launchPersistentContext(userDataDir, options) {
            return chromium.launchPersistentContext(userDataDir, {
              ...options,
              args: [...(options.args || []), ...extensionArgs]
            });
          }
        }
      })
    });
    assert.equal(unresolvedResumeOutcome.state, 'failed', JSON.stringify(unresolvedResumeOutcome));
    assert.equal(unresolvedResumeOutcome.error?.code, 'TASK_EFFECT_OUTCOME_UNKNOWN');
    const unresolvedAfterResume = await inspectEffectJournal(unresolvedJournalPath, { includeMetadata: true });
    assert.equal(unresolvedAfterResume.pending.length, 1);
    assert.equal(unresolvedAfterResume.pending[0].sequence, unresolvedJournal.pending[0].sequence);
    record('unresolved-extension-effect-blocks-resume-replay', {
      pendingSequence: unresolvedJournal.pending[0].sequence,
      pendingOperation: unresolvedJournal.pending[0].operation,
      resumeError: unresolvedResumeOutcome.error?.code,
      checkpointStage: unresolvedCheckpoint.data.stage
    });

    await clearTrace(page);
    const extensionCountBeforeDuplicate = Number(await page.locator('#extension-count').textContent());
    await dispatchExtensionCommand(page, {
      label: 'duplicate-extension',
      requestId: 'duplicate-extension',
      kind: 'click',
      duplicate: true,
      holdMs: 60
    });
    await waitForTrace(page, 'duplicate-extension:end');
    const extensionCountAfterDuplicate = Number(await page.locator('#extension-count').textContent());
    assert.equal(extensionCountAfterDuplicate - extensionCountBeforeDuplicate, 1);
    record('duplicate-extension-request-cannot-replay-action', {
      extensionClicks: 1,
      bridgeDuplicateSuppressed: true
    });

    await clearTrace(page);
    const navigationStartedAt = Date.now();
    await dispatchExtensionCommand(page, {
      label: 'extension-navigation',
      requestId: 'extension-navigation',
      kind: 'navigate',
      url: `${url}?extension-navigation=1`,
      holdMs: 100
    });
    await waitForTrace(page, 'extension-navigation:start');
    let taskAfterNavigationStarted = false;
    let taskAfterNavigationUrl = null;
    const taskAfterNavigation = coordinator.run('task-after-extension-navigation', async () => {
      taskAfterNavigationStarted = true;
      taskAfterNavigationUrl = page.url();
      await page.locator('#task-button').click();
    });
    assert.equal(coordinator.audit().pending, 1);
    assert.equal(taskAfterNavigationStarted, false);
    await page.waitForURL(/extension-navigation=1/u);
    await taskAfterNavigation;
    const navigationWaitMs = Date.now() - navigationStartedAt;
    assert.match(taskAfterNavigationUrl, /extension-navigation=1/u);
    assert.equal(coordinator.audit().navigationReleases >= 1, true);
    record('extension-navigation-releases-lease-at-document-boundary', {
      navigationWaitMs,
      navigationReleases: coordinator.audit().navigationReleases
    });

    await coordinator.run('ordinary-page-programmatic-click', async () => {
      await page.locator('#page-primary').click();
    });
    assert.equal(await page.locator('#page-secondary-count').textContent(), '1');
    assert.equal(coordinator.audit().conflicts, 0);
    record('ordinary-page-programmatic-events-do-not-false-positive', {
      secondaryClicks: 1,
      conflicts: coordinator.audit().conflicts
    });

    await clearTrace(page);
    const unintegratedCountBefore = Number(await page.locator('#extension-count').textContent());
    const unintegratedAuditBefore = coordinator.audit();
    let markUnintegratedTaskStarted;
    let releaseUnintegratedTask;
    const unintegratedTaskStarted = new Promise((resolve) => { markUnintegratedTaskStarted = resolve; });
    const unintegratedTaskRelease = new Promise((resolve) => { releaseUnintegratedTask = resolve; });
    const unintegratedTask = coordinator.run('unintegrated-extension-holder', async () => {
      await appendTrace(page, 'unintegrated-task:start');
      markUnintegratedTaskStarted();
      await unintegratedTaskRelease;
      await appendTrace(page, 'unintegrated-task:end');
    });
    await unintegratedTaskStarted;
    let unintegratedDuringTaskTrace;
    try {
      await dispatchExtensionCommand(page, {
        label: 'unintegrated-extension',
        kind: 'unintegrated-click',
        target: '#extension-button'
      });
      await waitForTrace(page, 'unintegrated-extension:end');
      unintegratedDuringTaskTrace = await readTrace(page);
      assertOrdered(unintegratedDuringTaskTrace, [
        'unintegrated-task:start',
        'unintegrated-extension:start',
        'extension-button:click',
        'unintegrated-extension:end'
      ]);
      assert.equal(labels(unintegratedDuringTaskTrace).includes('unintegrated-task:end'), false);
      assert.equal(Number(await page.locator('#extension-count').textContent()) - unintegratedCountBefore, 1);
      assert.equal(coordinator.audit().active, 1);
      assert.equal(coordinator.audit().pending, 0);
      assert.equal(coordinator.audit().extensionLeases, unintegratedAuditBefore.extensionLeases);
      assert.equal(coordinator.audit().conflicts, unintegratedAuditBefore.conflicts);
    } finally {
      releaseUnintegratedTask();
      await unintegratedTask;
    }
    const unintegratedFinalTrace = await readTrace(page);
    assertOrdered(unintegratedFinalTrace, [
      'unintegrated-task:start',
      'unintegrated-extension:start',
      'unintegrated-extension:end',
      'unintegrated-task:end'
    ]);
    record('unintegrated-extension-is-not-forced-into-fifo', {
      extensionClicks: 1,
      extensionLeaseDelta: coordinator.audit().extensionLeases - unintegratedAuditBefore.extensionLeases,
      overlapObserved: true,
      requiresPause: true,
      order: labels(unintegratedFinalTrace)
    });

    const proofModulePath = path.join(root, 'proof-failure-task.mjs');
    const proofOutputDir = path.join(root, 'proof-failure-output');
    const proofCheckpointPath = path.join(root, 'proof-failure-state', 'checkpoint.json');
    const proofProfileDir = path.join(root, 'proof-failure-profile');
    await writeFile(proofModulePath, [
      'export async function run({ journey, input }) {',
      '  await journey.open(input.url);',
      "  await journey.navigate('#task-button', { verify: async () => {",
      "    await journey.click('#extension-button');",
      '    return true;',
      '  }});',
      "  return { summary: 'must not complete', evidence: [] };",
      '}',
      ''
    ].join('\n'));
    const proofStartedAt = Date.now();
    const proofOutcome = await runTaskWorker({
      taskId: 'task_extension_proof_failure_acceptance',
      attempt: 1,
      modulePath: proofModulePath,
      outputDir: proofOutputDir,
      checkpointPath: proofCheckpointPath,
      input: { url },
      behavior: 'fast',
      interactionContract: 'full-human-v1',
      profile: {
        kind: 'persistent',
        browserEngine: 'chromium',
        userDataDir: proofProfileDir,
        headless: false,
        extensionsEnabled: true
      },
      heartbeatMs: 1_000,
      timeoutMs: 30_000
    }, {
      loadPlaywright: async () => ({
        chromium: {
          launchPersistentContext(userDataDir, options) {
            return chromium.launchPersistentContext(userDataDir, {
              ...options,
              args: [...(options.args || []), ...extensionArgs]
            });
          }
        }
      })
    });
    const proofDurationMs = Date.now() - proofStartedAt;
    assert.equal(proofOutcome.state, 'failed');
    assert.equal(proofOutcome.error.code, 'TASK_ACTION_REENTRANT');
    const proofJournal = await inspectEffectJournal(
      path.join(path.dirname(proofCheckpointPath), 'effect-journal.jsonl')
    );
    assert.deepEqual(proofJournal.pending.map((item) => item.operation), ['custom']);
    record('post-effect-proof-failure-is-durable-unknown-and-never-deadlocks', {
      errorCode: proofOutcome.error.code,
      durationMs: proofDurationMs,
      pendingEffects: proofJournal.pending.length
    });

    const timeoutProofModulePath = path.join(root, 'timeout-proof-task.mjs');
    const timeoutProofOutputDir = path.join(root, 'timeout-proof-output');
    const timeoutProofCheckpointPath = path.join(root, 'timeout-proof-state', 'checkpoint.json');
    const timeoutProofProfileDir = path.join(root, 'timeout-proof-profile');
    await writeFile(timeoutProofModulePath, [
      'export async function run({ journey, input }) {',
      '  await journey.open(input.url);',
      "  await journey.navigate('#task-button', { verify: async () => new Promise(() => {}) });",
      "  return { summary: 'must not complete', evidence: [] };",
      '}',
      ''
    ].join('\n'));
    const timeoutProofOutcome = await runTaskWorker({
      taskId: 'task_extension_timeout_proof_acceptance',
      attempt: 1,
      modulePath: timeoutProofModulePath,
      outputDir: timeoutProofOutputDir,
      checkpointPath: timeoutProofCheckpointPath,
      input: { url },
      behavior: 'fast',
      interactionContract: 'full-human-v1',
      profile: {
        kind: 'persistent',
        browserEngine: 'chromium',
        userDataDir: timeoutProofProfileDir,
        headless: false,
        extensionsEnabled: true
      },
      heartbeatMs: 1_000,
      timeoutMs: 5_000
    }, {
      loadPlaywright: async () => ({
        chromium: {
          launchPersistentContext(userDataDir, options) {
            return chromium.launchPersistentContext(userDataDir, {
              ...options,
              args: [...(options.args || []), ...extensionArgs]
            });
          }
        }
      })
    });
    assert.equal(timeoutProofOutcome.state, 'failed');
    assert.equal(timeoutProofOutcome.error.code, 'TASK_TIMEOUT');
    const timeoutProofJournal = await inspectEffectJournal(
      path.join(path.dirname(timeoutProofCheckpointPath), 'effect-journal.jsonl')
    );
    assert.deepEqual(timeoutProofJournal.pending.map((item) => item.operation), ['custom']);
    record('timeout-during-post-effect-proof-is-durable-unknown', {
      errorCode: timeoutProofOutcome.error.code,
      pendingEffects: timeoutProofJournal.pending.length
    });

    await clearTrace(page);
    const extensionLeasesBeforeStaleGrant = coordinator.audit().extensionLeases;
    const staleCommand = dispatchExtensionCommand(page, {
      label: 'stale-extension-grant',
      requestId: 'stale-extension-grant',
      kind: 'click',
      durationMs: 250,
      blockMs: 800,
      holdMs: 0
    });
    await waitForCoordinatorAudit(
      coordinator,
      (audit) => audit.extensionLeases === extensionLeasesBeforeStaleGrant + 1,
      'the stale-grant probe must acquire its extension lease before Task work is queued'
    );
    let staleTaskStarted = false;
    const staleTaskOutcome = coordinator.run('task-after-stale-extension-grant', async () => {
      staleTaskStarted = true;
    }).then(() => null, (error) => error);
    await staleCommand;
    await waitForTrace(page, 'stale-extension-grant:rejected');
    const staleTaskError = await staleTaskOutcome;
    assert.equal(staleTaskStarted, false);
    assert.equal(staleTaskError?.code, 'BROWSER_ACTION_CONFLICT');
    assert.equal(coordinator.audit().leaseTimeouts, 1);
    assert.equal(coordinator.audit().healthy, false);
    record('stale-extension-grant-fails-closed-before-task-can-start', {
      taskStarted: staleTaskStarted,
      errorCode: staleTaskError.code,
      leaseTimeouts: coordinator.audit().leaseTimeouts,
      healthy: coordinator.audit().healthy
    });

    const coordinationAudit = coordinator.audit();
    assert.equal(coordinationAudit.serialized, true);
    assert.equal(coordinationAudit.maximumActive, 1);
    await coordinator.close();
    coordinator = null;
    await context.close();
    context = null;

    const disabled = resolveBrowserEngine({ chromium }, {
      kind: 'persistent',
      browserEngine: 'chromium',
      headless: false,
      extensionsEnabled: false
    });
    assert.equal('ignoreDefaultArgs' in disabled.launchOptions, false);
    context = await disabled.browserType.launchPersistentContext(profileDir, {
      ...disabled.launchOptions,
      headless: false
    });
    const disabledPage = context.pages()[0] || await context.newPage();
    await disabledPage.goto(url, { waitUntil: 'domcontentloaded' });
    await disabledPage.waitForTimeout(500);
    assert.equal(
      await disabledPage.locator('html').getAttribute('data-taskmaster-acceptance-extension'),
      null
    );
    assert.equal(
      context.serviceWorkers().some((worker) => worker.url().startsWith('chrome-extension://')),
      false
    );
    await disabledPage.locator('#task-button').click();
    assert.equal(await disabledPage.locator('#task-count').textContent(), '1');
    record('extensions-disabled-does-not-load-extension', {
      extensionMarker: null,
      extensionServiceWorkers: 0,
      playwrightTaskClicks: 1
    });

    const finishedAt = new Date();
    const report = {
      ok: true,
      protocol: EXTENSION_ACTION_PROTOCOL.version,
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      summary: { passed: checks.length, total: 17 },
      checks
    };
    assert.equal(report.summary.passed, report.summary.total);
    await writeOptionalReport(report, reportPath);
    return report;
  } catch (error) {
    const failedAt = new Date();
    const report = {
      ok: false,
      protocol: EXTENSION_ACTION_PROTOCOL.version,
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      startedAt: startedAt.toISOString(),
      finishedAt: failedAt.toISOString(),
      durationMs: failedAt.getTime() - startedAt.getTime(),
      summary: { passed: checks.length, total: 16 },
      checks,
      error: {
        code: String(error?.code || 'EXTENSION_ACCEPTANCE_FAILED'),
        message: String(error?.message || 'Extension acceptance failed').slice(0, 2_000),
        ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {})
      }
    };
    await writeOptionalReport(report, reportPath).catch(() => {});
    error.report = report;
    throw error;
  } finally {
    await coordinator?.close().catch(() => {});
    await context?.close().catch(() => {});
    if (server) await closeServer(server).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    const report = await runExtensionAcceptance();
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(error.report || {
      ok: false,
      error: {
        code: String(error?.code || 'EXTENSION_ACCEPTANCE_FAILED'),
        message: String(error?.message || 'Extension acceptance failed').slice(0, 2_000)
      }
    })}\n`);
    process.exitCode = 1;
  }
}
