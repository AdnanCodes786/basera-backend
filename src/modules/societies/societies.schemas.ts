import { z } from 'zod';

const Address = z.strictObject({
  line1: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Pincode must be 6 digits')
    .optional(),
});

export const CreateSocietyBody = z.strictObject({
  name: z.string().trim().min(2).max(150),
  address: Address.optional(),
});

export const UpdateSocietyBody = z
  .strictObject({
    name: z.string().trim().min(2).max(150).optional(),
    address: Address.optional(),
    settings: z
      .strictObject({
        complaintSlaHours: z.number().int().min(1).max(24 * 14).optional(),
      })
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export type CreateSocietyInput = z.infer<typeof CreateSocietyBody>;
export type UpdateSocietyInput = z.infer<typeof UpdateSocietyBody>;
