import { AppError, Errors } from '../lib/errors.js';

export function notFoundHandler(req, _res, next) {
  next(Errors.notFound(`Route ${req.method} ${req.path} not found`));
}

export function errorHandler(err, req, res, _next) {
  const log = req.log || console;
  const requestId = req.id || 'unknown';

  if (err instanceof AppError) {
    log.warn({ code: err.code, status: err.statusCode, details: err.details }, err.message);
    return res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
      details: err.details,
      requestId,
    });
  }

  log.error({ err: { message: err.message, stack: err.stack } }, 'unhandled.error');

  // In development, surface the real error message so we can debug fast.
  const isDev = process.env.NODE_ENV !== 'production';
  return res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: isDev ? err.message : 'An unexpected error occurred',
    stack: isDev ? (err.stack || '').split('\n').slice(0, 6).join('\n') : undefined,
    requestId,
  });
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}