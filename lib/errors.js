export class AppError extends Error {
  constructor(code, message, statusCode = 500, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
  }
}

export const Errors = {
  validation: (msg, details) => new AppError('VALIDATION_ERROR', msg, 400, details),
  notFound: (msg = 'Not found') => new AppError('NOT_FOUND', msg, 404),
  rateLimited: () => new AppError('RATE_LIMITED', 'Too many requests', 429),
  unauthorized: (msg = 'Unauthorized') => new AppError('UNAUTHORIZED', msg, 401),
  upstreamFailed: (service, msg) => new AppError('UPSTREAM_FAILED', `${service}: ${msg}`, 502),
  upstreamTimeout: (service) => new AppError('UPSTREAM_TIMEOUT', `${service} timed out`, 504),
  schemaInvalid: (errors) => new AppError('SCHEMA_INVALID', 'Model output failed schema validation', 500, { errors }),
  internal: (msg, details) => new AppError('INTERNAL_ERROR', msg, 500, details),
};