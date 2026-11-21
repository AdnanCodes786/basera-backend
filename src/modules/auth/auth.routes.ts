import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { authRateLimit } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { RefreshBody, StartBody, VerifyBody } from './auth.schemas.js';
import * as auth from './auth.service.js';

export const authRouter = Router();

/** Step 1: "Send code". Always answers the same, so nobody can probe which emails have accounts. */
authRouter.post('/email/start', authRateLimit, validate({ body: StartBody }), async (req, res) => {
  const { email, purpose } = req.valid!.body;
  await auth.startEmailCode(email, purpose);
  res.json({ ok: true, message: `If ${email} can sign in, a 6-digit code is on its way.`, expiresInMinutes: 10 });
});

/** Step 2: the code → signed in. New emails get an account (isNewUser: true → app asks for the name). */
authRouter.post('/email/verify', authRateLimit, validate({ body: VerifyBody }), async (req, res) => {
  const { email, code, deviceInfo } = req.valid!.body;
  const { user, isNewUser, tokens } = await auth.verifyEmailCode(email, code, deviceInfo);
  res.json({ user, isNewUser, ...tokens });
});

authRouter.post('/refresh', validate({ body: RefreshBody }), async (req, res) => {
  res.json(await auth.refresh(req.valid!.body.refreshToken));
});

authRouter.post('/logout', authenticate, validate({ body: RefreshBody }), async (req, res) => {
  await auth.logout(req.userId!, req.valid!.body.refreshToken);
  res.status(204).end();
});

authRouter.post('/logout-all', authenticate, async (req, res) => {
  await auth.logoutEverywhere(req.userId!);
  res.status(204).end();
});
