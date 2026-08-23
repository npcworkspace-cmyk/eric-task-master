const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export class TaskMasterClientError extends Error {
  constructor(code, message, { retryable = false, nextAction, statusCode } = {}) {
    super(message);
    this.name = 'TaskMasterClientError';
    this.code = SAFE_CODE.test(code) ? code : 'TASKMASTER_ERROR';
    this.retryable = retryable === true;
    this.nextAction = typeof nextAction === 'string' ? nextAction : undefined;
    this.statusCode = Number.isInteger(statusCode) ? statusCode : undefined;
  }
}

export function toPublicError(error) {
  if (error instanceof TaskMasterClientError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.nextAction ? { nextAction: error.nextAction } : {})
    };
  }
  return {
    code: 'TASKMASTER_INTERNAL_ERROR',
    message: 'Task Master could not complete the operation.',
    retryable: false,
    nextAction: 'Inspect the Task Master manager status without repeating an unknown action.'
  };
}

export function diagnosticLine(error) {
  const code = error instanceof TaskMasterClientError ? error.code : 'MCP_STDIO_ERROR';
  return `[eric-task-master:mcp] ${code}\n`;
}
