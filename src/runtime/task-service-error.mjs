export class TaskServiceError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = 'TaskServiceError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}
