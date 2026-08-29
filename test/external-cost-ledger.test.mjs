import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExternalCostLedger,
  externalCostLedgerUsage,
  reserveExternalCost,
  settleExternalCost
} from '../src/lib/external-cost-ledger.mjs';
import { publicTask } from '../src/contracts.mjs';

test('external cost ledger reserves and settles idempotently while rejecting conflicts and overspend', () => {
  const ledger = createExternalCostLedger({ currency: 'USD', maxAmount: 10 });
  const firstReservation = reserveExternalCost(ledger, { operationId: 'provider.page-1', estimatedAmount: 4 });
  assert.deepEqual(firstReservation.receipt, { execute: true, status: 'reserved' });
  const duplicateReservation = reserveExternalCost(ledger, { operationId: 'provider.page-1', estimatedAmount: 4 });
  assert.deepEqual(duplicateReservation.receipt, { execute: false, status: 'reserved' });
  assert.throws(
    () => reserveExternalCost(ledger, { operationId: 'provider.page-1', estimatedAmount: 3 }),
    { code: 'EXTERNAL_COST_OPERATION_CONFLICT' }
  );
  assert.deepEqual(externalCostLedgerUsage(ledger), {
    currency: 'USD', estimatedTotal: 4, actualTotal: 0, remainingAmount: 6, outstandingCount: 1
  });
  assert.equal(settleExternalCost(ledger, { operationId: 'provider.page-1', actualAmount: 2.5 }).changed, true);
  assert.equal(settleExternalCost(ledger, { operationId: 'provider.page-1', actualAmount: 2.5 }).changed, false);
  assert.deepEqual(
    reserveExternalCost(ledger, { operationId: 'provider.page-1', estimatedAmount: 4 }).receipt,
    { execute: false, status: 'settled' }
  );
  assert.throws(
    () => settleExternalCost(ledger, { operationId: 'provider.page-1', actualAmount: 2.6 }),
    { code: 'EXTERNAL_COST_OPERATION_CONFLICT' }
  );
  reserveExternalCost(ledger, { operationId: 'provider.page-2', estimatedAmount: 7.5 });
  assert.throws(
    () => settleExternalCost(ledger, { operationId: 'provider.page-2', actualAmount: 7.6 }),
    { code: 'TASK_EXTERNAL_COST_BUDGET_EXCEEDED' }
  );
  assert.throws(
    () => reserveExternalCost(ledger, { operationId: 'provider.zero', estimatedAmount: 0 }),
    { code: 'INVALID_EXTERNAL_COST_AMOUNT' }
  );
  assert.throws(
    () => reserveExternalCost(ledger, { operationId: 'provider.page-3', estimatedAmount: 0.1 }),
    { code: 'TASK_EXTERNAL_COST_BUDGET_EXCEEDED' }
  );
});

test('an operation reservation is an at-most-once execution grant and a hard per-operation ceiling', () => {
  const ledger = createExternalCostLedger({ currency: 'USD', maxAmount: 10 });
  const first = reserveExternalCost(ledger, { operationId: 'same-call', estimatedAmount: 4 });
  const concurrentReplay = reserveExternalCost(ledger, { operationId: 'same-call', estimatedAmount: 4 });
  assert.equal(first.receipt.execute, true);
  assert.equal(concurrentReplay.receipt.execute, false);
  settleExternalCost(ledger, { operationId: 'same-call', actualAmount: 4 });
  const resumeReplay = reserveExternalCost(ledger, { operationId: 'same-call', estimatedAmount: 4 });
  assert.deepEqual(resumeReplay.receipt, { execute: false, status: 'settled' });
  assert.throws(
    () => {
      reserveExternalCost(ledger, { operationId: 'underestimated-call', estimatedAmount: 1 });
      settleExternalCost(ledger, { operationId: 'underestimated-call', actualAmount: 2 });
    },
    { code: 'TASK_EXTERNAL_COST_BUDGET_EXCEEDED' }
  );
});

test('external cost ledger survives serialization and preserves the same task-wide balance', () => {
  const firstAttempt = createExternalCostLedger({ currency: 'USD', maxAmount: 5 });
  reserveExternalCost(firstAttempt, { operationId: 'attempt-1', estimatedAmount: 2 });
  settleExternalCost(firstAttempt, { operationId: 'attempt-1', actualAmount: 1.25 });
  const restarted = JSON.parse(JSON.stringify(firstAttempt));
  reserveExternalCost(restarted, { operationId: 'attempt-2', estimatedAmount: 3.75 });
  settleExternalCost(restarted, { operationId: 'attempt-2', actualAmount: 3.75 });
  assert.deepEqual(externalCostLedgerUsage(restarted), {
    currency: 'USD', estimatedTotal: 5.75, actualTotal: 5, remainingAmount: 0, outstandingCount: 0
  });
  assert.throws(
    () => reserveExternalCost(restarted, { operationId: 'attempt-3', estimatedAmount: 0.000001 }),
    { code: 'TASK_EXTERNAL_COST_BUDGET_EXCEEDED' }
  );
});

test('public task projection exposes only aggregate external cost usage', () => {
  const record = publicTask({
    id: `task_${'a'.repeat(32)}`,
    state: 'running',
    externalCostBudget: { currency: 'USD', maxAmount: 50 },
    externalCostLedger: {
      version: 1,
      currency: 'USD',
      maxAmount: 50,
      operations: {
        'private-provider-request-42': { estimatedAmount: 8, actualAmount: null, reservedAt: 'secret' }
      }
    },
    externalCostUsage: {
      currency: 'USD', estimatedTotal: 8, actualTotal: 0, remainingAmount: 42
    }
  });
  assert.deepEqual(record.externalCostUsage, {
    currency: 'USD', estimatedTotal: 8, actualTotal: 0, remainingAmount: 42
  });
  assert.equal('externalCostBudget' in record, false);
  assert.equal(JSON.stringify(record).includes('private-provider-request-42'), false);
  assert.equal(JSON.stringify(record).includes('maxAmount'), false);
});
