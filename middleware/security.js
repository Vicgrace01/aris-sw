import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

export const securityMiddleware = [
  helmet({ contentSecurityPolicy: false }),
  cors({ origin: config.cors.origin }),
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: 'Too many requests' },
  }),
];