import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

/** 10 attempts per 15 minutes per IP + email, for sign-in codes and joining. */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}:${String(req.body?.email ?? '').toLowerCase()}`,
  handler: (_req, res) => {
    res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again in 15 minutes.' } });
  },
});
