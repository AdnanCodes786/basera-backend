import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { MembershipModel } from '../../models/membership.js';
import { NotificationModel } from '../../models/notification.js';
import { SessionModel } from '../../models/session.js';
import { UserModel } from '../../models/user.js';
import { conflict, notFound } from '../../utils/errors.js';
import { PhoneSchema } from '../../utils/phone.js';
import { consumeEmailCode } from '../auth/auth.service.js';

export const meRouter = Router();
meRouter.use(authenticate);

const MAX_DEVICE_TOKENS = 10;

/** Profile plus memberships, so the app knows which society screen to open. */
meRouter.get('/', async (req, res) => {
  const user = await UserModel.findById(req.userId);
  if (!user) throw notFound('User');

  const memberships = await MembershipModel.find({ userId: user._id, status: { $in: ['pending', 'active'] } })
    .populate<{ societyId: { _id: unknown; name: string } }>('societyId', 'name')
    .populate<{ familyId: { _id: unknown; unitNumber: string } | null }>('familyId', 'unitNumber')
    .lean();

  res.json({
    user,
    memberships: memberships.map((m) => ({
      id: m._id,
      role: m.role,
      status: m.status,
      requestedUnit: m.requestedUnit,
      society: m.societyId ? { id: m.societyId._id, name: m.societyId.name } : null,
      family: m.familyId ? { id: m.familyId._id, unitNumber: m.familyId.unitNumber } : null,
    })),
  });
});

/** Email is the sign-in identity and can't be changed here. */
const PatchMeBody = z
  .strictObject({
    name: z.string().trim().min(2).max(100).optional(),
    phone: PhoneSchema.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

meRouter.patch('/', validate({ body: PatchMeBody }), async (req, res) => {
  const { name, phone } = req.valid!.body as z.infer<typeof PatchMeBody>;
  const user = await UserModel.findById(req.userId);
  if (!user) throw notFound('User');
  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone ?? undefined;
  await user.save();
  res.json({ user });
});

const DeviceTokenBody = z.strictObject({ token: z.string().min(10).max(4096) });

meRouter.post('/device-tokens', validate({ body: DeviceTokenBody }), async (req, res) => {
  const { token } = req.valid!.body;
  // Move the token to the end (most recent) and keep only the newest N.
  await UserModel.updateOne({ _id: req.userId }, { $pull: { deviceTokens: token } });
  await UserModel.updateOne({ _id: req.userId }, { $push: { deviceTokens: { $each: [token], $slice: -MAX_DEVICE_TOKENS } } });
  res.status(204).end();
});

meRouter.delete('/device-tokens/:token', async (req, res) => {
  await UserModel.updateOne({ _id: req.userId }, { $pull: { deviceTokens: req.params.token } });
  res.status(204).end();
});

const DeleteMeBody = z.strictObject({ code: z.string().trim().regex(/^\d{6}$/, 'The code has 6 digits') });

/**
 * Account deletion (DPDP Act). Confirmed with an emailed code
 * (POST /auth/email/start with purpose "delete_account").
 * Personal data is wiped; payments and complaints stay (the society's money trail)
 * but now point to "Deleted user". A chief must hand over the chief role first.
 */
meRouter.delete('/', validate({ body: DeleteMeBody }), async (req, res) => {
  const user = await UserModel.findById(req.userId);
  if (!user) throw notFound('User');
  if (await MembershipModel.exists({ userId: user._id, role: 'chief', status: 'active' })) {
    throw conflict('CHIEF_MUST_HAND_OVER', 'You are a chief. Give the chief role to someone else before deleting your account.');
  }
  await consumeEmailCode(user.email, req.valid!.body.code, 'delete_account');

  await MembershipModel.updateMany({ userId: user._id, status: { $in: ['active', 'pending'] } }, { $set: { status: 'left', role: 'resident' } });
  await SessionModel.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'logout' } });
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: { name: 'Deleted user', email: `deleted-${user._id}@deleted.invalid`, isActive: false, deviceTokens: [], deletedAt: new Date() },
      $unset: { phone: 1 },
    },
  );
  await NotificationModel.deleteMany({ userId: user._id });
  res.status(204).end();
});
