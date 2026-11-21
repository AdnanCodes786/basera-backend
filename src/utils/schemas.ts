import { z } from 'zod';
export { ObjectIdSchema } from './ids.js';

/** Money in whole paise. ₹2,000 = 200000. */
export const Paise = z.number().int().positive().max(1_000_000_000_00);
export const PaiseOrZero = z.number().int().min(0).max(1_000_000_000_00);

/** Billing month "YYYY-MM". */
export const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM');

export const DateInput = z.coerce.date();

export const Url = z.url().max(1000);

export const PAYMENT_MODES = ['cash', 'upi', 'bank_transfer', 'cheque', 'other'] as const;
export const PaymentMode = z.enum(PAYMENT_MODES);

/** Query-string boolean: "true" / "false". */
export const QueryBool = z.enum(['true', 'false']).transform((v) => v === 'true');

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
