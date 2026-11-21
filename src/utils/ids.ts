import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Types } from 'mongoose';
import { z } from 'zod';

export const ObjectIdSchema = z
  .string()
  .refine((v) => Types.ObjectId.isValid(v) && /^[0-9a-f]{24}$/i.test(v), 'Invalid id');

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 64): string {
  return randomBytes(bytes).toString('base64url');
}

// No 0/O, 1/I/L, so codes can be read out over the phone.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode(length = 8): string {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}
