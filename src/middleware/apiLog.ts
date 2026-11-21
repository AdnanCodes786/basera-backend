import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiLogModel } from '../models/apiLog.js';

/**
 * Writes one apiLogs row per request after the response is sent (never slows the response).
 * Stores who / what / status / timing / error code, never bodies or tokens.
 */
export const apiLog: RequestHandler = (req, res, next) => {
  if (!env.ENABLE_API_LOGS || req.path === '/health') return next();
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : undefined;
    ApiLogModel.create({
      requestId: String(req.id ?? ''),
      method: req.method,
      path: req.originalUrl.split('?')[0],
      route,
      query: Object.keys(req.query ?? {}).length ? req.query : undefined,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      userId: req.userId ?? null,
      societyId: req.membership?.societyId ?? null,
      errorCode: (res.locals.errorCode as string | undefined) ?? null,
      ip: req.ip,
      userAgent: req.get('user-agent')?.slice(0, 200),
    }).catch((err) => logger.warn({ err }, 'apiLog write failed'));
  });
  next();
};
