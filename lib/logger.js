import pino from 'pino';
import { config } from '../config.js';

const transport = config.isProd ? undefined : {
  target: 'pino-pretty',
  options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,reqId,method,path' }
};

export const logger = pino({
  level: config.log.level,
  base: { service: 'aris-sw' },
  ...(transport ? { transport } : {}),
});