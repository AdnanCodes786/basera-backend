import { z } from 'zod';

export const Email = z.email('Enter a valid email').trim().toLowerCase().max(200);
const DeviceInfo = z.string().trim().max(200).optional();

export const StartBody = z.strictObject({
  email: Email,
  purpose: z.enum(['login', 'delete_account']).default('login'),
});

export const VerifyBody = z.strictObject({
  email: Email,
  code: z.string().trim().regex(/^\d{6}$/, 'The code has 6 digits'),
  deviceInfo: DeviceInfo,
});

export const RefreshBody = z.strictObject({
  refreshToken: z.string().min(20).max(200),
});

export type StartInput = z.infer<typeof StartBody>;
export type VerifyInput = z.infer<typeof VerifyBody>;
