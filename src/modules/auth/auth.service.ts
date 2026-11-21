import { randomInt } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { EmailCodeModel } from '../../models/emailCode.js';
import { InviteModel } from '../../models/invite.js';
import { SessionModel } from '../../models/session.js';
import { UserModel } from '../../models/user.js';
import { loginCodeEmail, sendEmail } from '../../services/email.js';
import { addDays } from '../../utils/dates.js';
import { AppError, unauthorized } from '../../utils/errors.js';
import { randomToken, sha256 } from '../../utils/ids.js';

export type Tokens = { accessToken: string; refreshToken: string; accessTokenExpiresIn: string };

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_CODE_ATTEMPTS = 5;

function signAccessToken(userId: string): string {
  return jwt.sign({}, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

async function startSession(userId: Types.ObjectId | string, deviceInfo?: string): Promise<Tokens> {
  const refreshToken = randomToken(64);
  await SessionModel.create({
    userId,
    tokenHash: sha256(refreshToken),
    deviceInfo,
    expiresAt: addDays(new Date(), env.REFRESH_TOKEN_TTL_DAYS),
  });
  return { accessToken: signAccessToken(String(userId)), refreshToken, accessTokenExpiresIn: env.ACCESS_TOKEN_TTL };
}

/** Emails a 6-digit code (valid 10 minutes). Same answer whether or not an account exists. */
export async function startEmailCode(email: string, purpose: 'login' | 'delete_account'): Promise<void> {
  const existing = await EmailCodeModel.findOne({ email, purpose }).lean();
  if (existing && Date.now() - existing.updatedAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new AppError(429, 'CODE_COOLDOWN', 'A code was just sent. Wait 30 seconds before asking again.');
  }
  if (purpose === 'delete_account' && !(await UserModel.exists({ email, isActive: true }))) return;

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await EmailCodeModel.findOneAndUpdate(
    { email, purpose },
    { $set: { codeHash: sha256(code), expiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0 } },
    { upsert: true },
  );
  await sendEmail({ ...loginCodeEmail(code, purpose), to: email });
}

/** Checks and burns a code. Wrong codes count; after 5 the code is dead. */
export async function consumeEmailCode(email: string, code: string, purpose: 'login' | 'delete_account'): Promise<void> {
  const invalid = () => unauthorized('INVALID_CODE', 'That code is wrong or has expired. Ask for a new one.');
  const row = await EmailCodeModel.findOne({ email, purpose });
  if (!row || row.expiresAt < new Date() || row.attempts >= MAX_CODE_ATTEMPTS) throw invalid();
  if (row.codeHash !== sha256(code)) {
    row.attempts += 1;
    await row.save();
    throw invalid();
  }
  await row.deleteOne();
}

/**
 * Verifies the code and signs in. A new email gets an account on the spot; its name comes
 * from a pending invite if there is one, else from the email (the app then asks for the real name).
 */
export async function verifyEmailCode(email: string, code: string, deviceInfo?: string) {
  await consumeEmailCode(email, code, 'login');

  let user = await UserModel.findOne({ email });
  let isNewUser = false;
  if (user && !user.isActive) throw unauthorized('ACCOUNT_DISABLED', 'This account has been disabled');
  if (!user) {
    const invite = await InviteModel.findOne({ email, status: 'pending' }).sort({ createdAt: -1 }).lean();
    user = await UserModel.create({ email, name: invite?.name ?? email.split('@')[0], phone: invite?.phone ?? undefined });
    isNewUser = true;
  }
  user.lastLoginAt = new Date();
  await user.save();
  return { user, isNewUser, tokens: await startSession(user._id, deviceInfo) };
}

/**
 * Refresh-token rotation. Presenting a token that was already rotated means it was copied,
 * so every session of that user is revoked.
 */
export async function refresh(refreshToken: string): Promise<Tokens> {
  const tokenHash = sha256(refreshToken);
  const now = new Date();
  const session = await SessionModel.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now, revokedReason: 'rotation' } },
  );

  if (!session) {
    const existing = await SessionModel.findOne({ tokenHash }).lean();
    if (existing?.revokedReason === 'rotation') {
      await SessionModel.updateMany(
        { userId: existing.userId, revokedAt: null },
        { $set: { revokedAt: now, revokedReason: 'reuse_detected' } },
      );
      throw unauthorized('TOKEN_REUSED', 'Session expired. Please sign in again.');
    }
    throw unauthorized('INVALID_REFRESH_TOKEN', 'Session expired. Please sign in again.');
  }

  const user = await UserModel.findById(session.userId).lean();
  if (!user || !user.isActive) throw unauthorized('ACCOUNT_DISABLED', 'This account has been disabled');
  return startSession(session.userId, session.deviceInfo ?? undefined);
}

export async function logout(userId: string, refreshToken: string): Promise<void> {
  await SessionModel.updateOne(
    { tokenHash: sha256(refreshToken), userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
  );
}

export async function logoutEverywhere(userId: string): Promise<void> {
  await SessionModel.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'logout' } });
}
