import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { unauthorized } from '../utils/errors.js';

/** Verifies the `Authorization: Bearer <access token>` header and sets `req.userId`. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();

  try {
    const payload = jwt.verify(header.slice(7), env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || !payload.sub) throw new Error('bad payload');
    req.userId = payload.sub;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw unauthorized('TOKEN_EXPIRED', 'Access token expired');
    throw unauthorized('INVALID_TOKEN', 'Invalid access token');
  }
  next();
};
