import { nanoid } from 'nanoid';
import { logger } from '../lib/logger.js';

export function requestContext(req, res, next) {
  req.id = req.headers['x-request-id'] || nanoid(12);
  req.startedAt = Date.now();
  res.setHeader('X-Request-Id', req.id);

  req.log = logger.child({ reqId: req.id, method: req.method, path: req.path });

  res.on('finish', () => {
    req.log.info({ status: res.statusCode, durationMs: Date.now() - req.startedAt }, 'request.complete');
  });

  next();
}