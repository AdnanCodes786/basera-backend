import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { apiLog } from './middleware/apiLog.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import './models/index.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { publicInvitesRouter } from './modules/invites/invites.routes.js';
import { meRouter } from './modules/me/me.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { societiesRouter } from './modules/societies/societies.routes.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // behind Render / Railway / nginx
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string) || randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // One clean line per request: "POST /api/v1/auth/email/start 200 34ms". No headers, bodies or IPs.
      autoLogging: { ignore: (req) => req.url === '/health' },
      serializers: { req: () => undefined, res: () => undefined },
      customAttributeKeys: { responseTime: 'ms' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      customSuccessMessage: (req, res, ms) => `${req.method} ${req.url} ${res.statusCode} ${Math.round(ms)}ms`,
      customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode} failed`,
    }),
  );
  app.use(apiLog); // one row per request in the apiLogs collection
  app.use(helmet());
  // The mobile app needs no CORS; only listed web origins (future dashboard) are allowed.
  app.use(cors({ origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : false }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ success: true, message:"basera backend connected successfully" });
  });

  const api = express.Router();
  api.use('/auth', authRouter);
  api.use('/me', meRouter);
  api.use('/invites', publicInvitesRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/societies', societiesRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
