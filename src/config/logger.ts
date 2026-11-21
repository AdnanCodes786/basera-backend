import { pino } from 'pino';
import { env, isProd, isTest } from './env.js';

/**
 * Development: short coloured lines, e.g. `01:56:32 INFO POST /api/v1/auth/email/start 200 34ms`.
 * Production: JSON lines (method/path/status/ms + request id) for a log service.
 * Request/response objects, headers and bodies are never logged.
 */
export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  base: undefined, // no pid / hostname on every line
  redact: ['req.headers.authorization', 'req.body', 'res.headers'],
  ...(isProd || isTest
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'reqId,ms,req,res',
            singleLine: true,
          },
        },
      }),
});
