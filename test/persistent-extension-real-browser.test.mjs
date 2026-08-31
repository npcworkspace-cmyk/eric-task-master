import assert from 'node:assert/strict';
import test from 'node:test';

import { runExtensionAcceptance } from '../scripts/extension-acceptance.mjs';

test('real cooperative MV3 extension actions and Task Master actions serialize without replay', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1',
  timeout: 120_000
}, async () => {
  const report = await runExtensionAcceptance();
  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, { passed: 15, total: 15 });
  assert.deepEqual(report.checks.map((item) => item.name), [
    'mv3-content-script-and-service-worker-loaded',
    'cooperative-extension-lease-blocks-task',
    'participant-scoped-request-ids-cannot-cross-grant-leases',
    'pre-existing-iframe-is-coordinated-and-top-navigation-releases-it',
    'unrelated-tab-navigation-does-not-release-source-but-source-close-does',
    'task-lease-blocks-cooperative-extension',
    'task-actions-are-strict-fifo',
    'real-worker-journey-and-extension-share-the-runtime-fifo',
    'duplicate-extension-request-cannot-replay-action',
    'extension-navigation-releases-lease-at-document-boundary',
    'ordinary-page-programmatic-events-do-not-false-positive',
    'post-effect-proof-failure-is-durable-unknown-and-never-deadlocks',
    'timeout-during-post-effect-proof-is-durable-unknown',
    'stale-extension-grant-fails-closed-before-task-can-start',
    'extensions-disabled-does-not-load-extension'
  ]);
  assert.ok(report.checks.every((item) => item.ok === true));
});
