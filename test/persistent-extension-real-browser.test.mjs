import assert from 'node:assert/strict';
import test from 'node:test';

import { runExtensionAcceptance } from '../scripts/extension-acceptance.mjs';

test('real MV3 proves cooperative serialization and the unintegrated-extension boundary', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1' || process.env.TASKMASTER_EXTENSION_STAGE !== '1',
  timeout: 120_000
}, async () => {
  const report = await runExtensionAcceptance();
  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, { passed: 17, total: 17 });
  assert.deepEqual(report.checks.map((item) => item.name), [
    'mv3-content-script-and-service-worker-loaded',
    'cooperative-extension-lease-blocks-task',
    'participant-scoped-request-ids-cannot-cross-grant-leases',
    'pre-existing-iframe-is-coordinated-and-top-navigation-releases-it',
    'unrelated-tab-navigation-does-not-release-source-but-source-close-does',
    'task-lease-blocks-cooperative-extension',
    'task-actions-are-strict-fifo',
    'real-worker-extension-handoff-gates-task-takeover',
    'unresolved-extension-effect-blocks-resume-replay',
    'duplicate-extension-request-cannot-replay-action',
    'extension-navigation-releases-lease-at-document-boundary',
    'ordinary-page-programmatic-events-do-not-false-positive',
    'unintegrated-extension-is-not-forced-into-fifo',
    'post-effect-proof-failure-is-durable-unknown-and-never-deadlocks',
    'timeout-during-post-effect-proof-is-durable-unknown',
    'stale-extension-grant-fails-closed-before-task-can-start',
    'extensions-disabled-does-not-load-extension'
  ]);
  assert.deepEqual(report.checks[0].evidence.chromeApis, [
    'storage', 'tabs', 'scripting', 'host-permissions'
  ]);
  const workerHandoff = report.checks.find(
    (item) => item.name === 'real-worker-extension-handoff-gates-task-takeover'
  );
  assert.equal(workerHandoff?.evidence?.taskCountBeforeTakeover, 0);
  assert.equal(
    workerHandoff?.evidence?.checkpointLinkedReceipt,
    workerHandoff?.evidence?.taskResolution?.receiptId
  );
  const unresolvedReplay = report.checks.find(
    (item) => item.name === 'unresolved-extension-effect-blocks-resume-replay'
  );
  assert.equal(unresolvedReplay?.evidence?.resumeError, 'TASK_EFFECT_OUTCOME_UNKNOWN');
  assert.ok(report.checks.every((item) => item.ok === true));
});
