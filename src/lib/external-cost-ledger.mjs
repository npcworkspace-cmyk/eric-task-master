const OPERATION_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const AMOUNT_SCALE = 1_000_000;

export class ExternalCostLedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExternalCostLedgerError';
    this.code = code;
  }
}

function amountUnits(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ExternalCostLedgerError(
      'INVALID_EXTERNAL_COST_AMOUNT',
      `${field} must be a non-negative finite number`
    );
  }
  const units = Math.round(value * AMOUNT_SCALE);
  if (!Number.isSafeInteger(units) || Math.abs((units / AMOUNT_SCALE) - value) > Number.EPSILON * 8) {
    throw new ExternalCostLedgerError(
      'INVALID_EXTERNAL_COST_AMOUNT',
      `${field} must contain at most 6 decimal places`
    );
  }
  return units;
}

function amountValue(units) {
  return units / AMOUNT_SCALE;
}

function positiveAmountUnits(value, field) {
  const units = amountUnits(value, field);
  if (units <= 0) {
    throw new ExternalCostLedgerError(
      'INVALID_EXTERNAL_COST_AMOUNT',
      `${field} must be greater than zero`
    );
  }
  return units;
}

function validateOperationId(operationId) {
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new ExternalCostLedgerError(
      'INVALID_EXTERNAL_COST_OPERATION_ID',
      'operationId must contain 1-128 letters, numbers, dots, underscores, colons, or hyphens'
    );
  }
  return operationId;
}

function validateLedger(ledger) {
  if (
    !ledger || ledger.version !== 1 || typeof ledger.currency !== 'string' ||
    typeof ledger.maxAmount !== 'number' || !ledger.operations ||
    typeof ledger.operations !== 'object' || Array.isArray(ledger.operations)
  ) {
    throw new ExternalCostLedgerError('EXTERNAL_COST_LEDGER_INVALID', 'External cost ledger is invalid');
  }
  amountUnits(ledger.maxAmount, 'ledger.maxAmount');
  return ledger;
}

export function createExternalCostLedger({ currency, maxAmount }) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new ExternalCostLedgerError('EXTERNAL_COST_LEDGER_INVALID', 'currency must be a three-letter uppercase code');
  }
  positiveAmountUnits(maxAmount, 'maxAmount');
  return {
    version: 1,
    currency,
    maxAmount,
    operations: {}
  };
}

export function externalCostLedgerUsage(ledger) {
  validateLedger(ledger);
  let estimatedUnits = 0;
  let actualUnits = 0;
  let outstandingUnits = 0;
  let outstandingCount = 0;
  for (const entry of Object.values(ledger.operations)) {
    const estimated = amountUnits(entry?.estimatedAmount, 'estimatedAmount');
    estimatedUnits += estimated;
    if (entry.actualAmount === null || entry.actualAmount === undefined) {
      outstandingUnits += estimated;
      outstandingCount += 1;
    } else {
      actualUnits += amountUnits(entry.actualAmount, 'actualAmount');
    }
  }
  const maxUnits = amountUnits(ledger.maxAmount, 'ledger.maxAmount');
  return Object.freeze({
    currency: ledger.currency,
    estimatedTotal: amountValue(estimatedUnits),
    actualTotal: amountValue(actualUnits),
    remainingAmount: amountValue(Math.max(0, maxUnits - actualUnits - outstandingUnits)),
    outstandingCount
  });
}

export function reserveExternalCost(ledger, {
  operationId,
  estimatedAmount,
  at = new Date().toISOString()
}) {
  validateLedger(ledger);
  validateOperationId(operationId);
  const estimatedUnits = positiveAmountUnits(estimatedAmount, 'estimatedAmount');
  const existing = ledger.operations[operationId];
  if (existing) {
    if (amountUnits(existing.estimatedAmount, 'estimatedAmount') !== estimatedUnits) {
      throw new ExternalCostLedgerError(
        'EXTERNAL_COST_OPERATION_CONFLICT',
        'operationId is already bound to a different external cost reservation'
      );
    }
    return {
      changed: false,
      receipt: {
        execute: false,
        status: existing.actualAmount === null || existing.actualAmount === undefined ? 'reserved' : 'settled'
      },
      usage: externalCostLedgerUsage(ledger)
    };
  }
  const usage = externalCostLedgerUsage(ledger);
  if (estimatedUnits > amountUnits(usage.remainingAmount, 'remainingAmount')) {
    throw new ExternalCostLedgerError(
      'TASK_EXTERNAL_COST_BUDGET_EXCEEDED',
      'External cost reservation exceeds the remaining task budget'
    );
  }
  ledger.operations[operationId] = {
    estimatedAmount: amountValue(estimatedUnits),
    actualAmount: null,
    reservedAt: at
  };
  return {
    changed: true,
    receipt: { execute: true, status: 'reserved' },
    usage: externalCostLedgerUsage(ledger)
  };
}

export function settleExternalCost(ledger, {
  operationId,
  actualAmount,
  at = new Date().toISOString()
}) {
  validateLedger(ledger);
  validateOperationId(operationId);
  const actualUnits = amountUnits(actualAmount, 'actualAmount');
  const existing = ledger.operations[operationId];
  if (!existing) {
    throw new ExternalCostLedgerError(
      'EXTERNAL_COST_RESERVATION_REQUIRED',
      'External cost must be reserved before it is settled'
    );
  }
  if (existing.actualAmount !== null && existing.actualAmount !== undefined) {
    if (amountUnits(existing.actualAmount, 'actualAmount') !== actualUnits) {
      throw new ExternalCostLedgerError(
        'EXTERNAL_COST_OPERATION_CONFLICT',
        'operationId is already bound to a different external cost settlement'
      );
    }
    return {
      changed: false,
      receipt: { execute: false, status: 'settled' },
      usage: externalCostLedgerUsage(ledger)
    };
  }
  const currentReservationUnits = amountUnits(existing.estimatedAmount, 'estimatedAmount');
  if (actualUnits > currentReservationUnits) {
    throw new ExternalCostLedgerError(
      'TASK_EXTERNAL_COST_BUDGET_EXCEEDED',
      'External cost settlement exceeds its pre-authorized reservation'
    );
  }
  existing.actualAmount = amountValue(actualUnits);
  existing.settledAt = at;
  return {
    changed: true,
    receipt: { execute: false, status: 'settled' },
    usage: externalCostLedgerUsage(ledger)
  };
}
