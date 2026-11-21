import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { FamilyModel } from '../../models/family.js';
import { InviteModel } from '../../models/invite.js';
import { MembershipModel } from '../../models/membership.js';
import { SocietyModel } from '../../models/society.js';
import { UserModel } from '../../models/user.js';
import { audit } from '../../services/audit.js';
import { sendEmail } from '../../services/email.js';
import { notify } from '../../services/notify.js';
import { adminUserIds } from '../../services/recipients.js';
import { isAdmin, isFamilyHead, loadFamily, member } from '../../utils/access.js';
import { addDays } from '../../utils/dates.js';
import { conflict, forbidden, notFound } from '../../utils/errors.js';
import { randomToken, sha256 } from '../../utils/ids.js';
import { PaginationQuery, pageResult, skipFor } from '../../utils/pagination.js';
import { PhoneSchema } from '../../utils/phone.js';
import { ObjectIdSchema } from '../../utils/schemas.js';

const IdParams = z.object({ id: ObjectIdSchema });
type InviteDoc = InstanceType<typeof InviteModel>;

function linkFor(token: string) {
  return `${env.INVITE_LINK_BASE.replace(/\/$/, '')}/${token}`;
}

/** The message the committee shares on WhatsApp (and the invite email body). */
function shareMessage(p: { name: string; societyName: string; unit: string; link: string; email: string }) {
  const first = p.name.split(' ')[0];
  return (
    `Namaste ${first} ji, ${p.societyName} has added your home ${p.unit} on Basera. ` +
    `Join to see your dues, raise complaints and read notices.\n${p.link}\n` +
    `Works for ${env.INVITE_TTL_DAYS} days, only for ${p.email}`
  );
}

/** Pending invites past expiry are reported as expired even before the cleanup job marks them. */
function withLiveStatus(invite: InviteDoc) {
  const json = invite.toJSON() as Record<string, unknown>;
  if (invite.status === 'pending' && invite.expiresAt < new Date()) json.status = 'expired';
  return json;
}

async function issueToken(invite: InviteDoc) {
  const token = randomToken(24);
  invite.tokenHash = sha256(token);
  invite.expiresAt = addDays(new Date(), env.INVITE_TTL_DAYS);
  invite.status = 'pending';
  invite.openedAt = undefined;
  await invite.save();
  return token;
}

/** Builds the link + message, and emails the invite (an email failure never blocks the invite). */
async function deliver(invite: InviteDoc, token: string) {
  const [society, family] = await Promise.all([
    SocietyModel.findById(invite.societyId, { name: 1 }).lean(),
    FamilyModel.findById(invite.familyId, { unitNumber: 1 }).lean(),
  ]);
  const link = linkFor(token);
  const message = shareMessage({ name: invite.name, societyName: society?.name ?? 'Your colony', unit: family?.unitNumber ?? '', link, email: invite.email });
  let emailSent = true;
  try {
    await sendEmail({ to: invite.email, subject: `Join ${society?.name ?? 'your colony'} on Basera`, text: message });
  } catch (err) {
    emailSent = false;
    logger.warn({ inviteId: invite._id, reason: err instanceof Error ? err.message : 'unknown' }, 'Invite email failed; the link can still be shared');
  }
  return { invite: withLiveStatus(invite), emailSent, token, link, shareMessage: message };
}

// =========================== Society-scoped: /societies/:societyId/invites ===========================
export const invitesRouter = Router({ mergeParams: true });

const CreateBody = z.strictObject({
  familyId: ObjectIdSchema,
  name: z.string().trim().min(2).max(100),
  email: z.email().trim().toLowerCase(),
  phone: PhoneSchema.optional(), // for the directory
  occupancy: z.enum(['owner', 'tenant']).optional(),
});

/**
 * Admins invite into any house. Inviting into an EMPTY house makes this person the head of the family.
 * A family head may invite people of their own home.
 */
invitesRouter.post('/', requirePermission('invites.send'), validate({ body: CreateBody }), async (req, res) => {
  const body = req.valid!.body as z.infer<typeof CreateBody>;
  const { societyId } = member(req);
  const family = await loadFamily(req, body.familyId, { activeOnly: true });
  const admin = isAdmin(req);
  if (!admin && !(await isFamilyHead(req, family))) {
    throw forbidden('NOT_FAMILY_HEAD', 'You can only invite people to your own home');
  }

  const existingUser = await UserModel.findOne({ email: body.email }, { _id: 1 }).lean();
  if (existingUser && (await MembershipModel.exists({ userId: existingUser._id, societyId, status: 'active' }))) {
    throw conflict('ALREADY_MEMBER', 'This person is already a member of the society');
  }

  if (family.get('isVacant')) {
    if (!admin) throw forbidden();
    family.set('head', { name: body.name, email: body.email, phone: body.phone });
    if (body.occupancy) family.occupancy = body.occupancy;
    await family.save();
  }

  // One live invite per email per society: older pending ones are revoked.
  await InviteModel.updateMany({ societyId, email: body.email, status: 'pending' }, { $set: { status: 'revoked' } });
  const invite = new InviteModel({ societyId, familyId: family._id, name: body.name, email: body.email, phone: body.phone, invitedBy: req.userId });
  const token = await issueToken(invite);
  await audit({ societyId, actorId: req.userId!, action: 'invite.created', entity: 'invite', entityId: invite._id, after: { email: body.email, familyId: body.familyId } });
  res.status(201).json(await deliver(invite, token));
});

const ListQuery = PaginationQuery.extend({
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']).optional(),
  familyId: ObjectIdSchema.optional(),
});

invitesRouter.get('/', requirePermission('invites.manage'), validate({ query: ListQuery }), async (req, res) => {
  const q = req.valid!.query as z.infer<typeof ListQuery>;
  const now = new Date();
  const filter: Record<string, unknown> = { societyId: member(req).societyId };
  if (q.familyId) filter.familyId = q.familyId;
  if (q.status === 'pending') Object.assign(filter, { status: 'pending', expiresAt: { $gte: now } });
  else if (q.status === 'expired') filter.$or = [{ status: 'expired' }, { status: 'pending', expiresAt: { $lt: now } }];
  else if (q.status) filter.status = q.status;

  const [items, total] = await Promise.all([
    InviteModel.find(filter).sort({ createdAt: -1 }).skip(skipFor(q)).limit(q.limit),
    InviteModel.countDocuments(filter),
  ]);
  res.json(pageResult(items.map(withLiveStatus), total, q));
});

async function loadOwnInvite(req: Parameters<typeof member>[0], id: string) {
  const invite = await InviteModel.findOne({ _id: id, societyId: member(req).societyId });
  if (!invite) throw notFound('Invite');
  if (!isAdmin(req)) {
    const family = await FamilyModel.findById(invite.familyId);
    if (!family || !(await isFamilyHead(req, family))) throw forbidden();
  }
  if (invite.status === 'accepted') throw conflict('ALREADY_ACCEPTED', 'This invite was already accepted');
  return invite;
}

/** New token + new expiry (the old link stops working); the email goes out again. */
invitesRouter.post('/:id/resend', requirePermission('invites.send'), validate({ params: IdParams }), async (req, res) => {
  const invite = await loadOwnInvite(req, req.valid!.params.id);
  const token = await issueToken(invite);
  res.json(await deliver(invite, token));
});

invitesRouter.post('/:id/revoke', requirePermission('invites.send'), validate({ params: IdParams }), async (req, res) => {
  const invite = await loadOwnInvite(req, req.valid!.params.id);
  invite.status = 'revoked';
  await invite.save();
  res.json({ invite: withLiveStatus(invite) });
});

// =========================== Public: /api/v1/invites/:token ===========================
export const publicInvitesRouter = Router();

const TokenParams = z.object({ token: z.string().min(10).max(100) });

async function findLiveInvite(token: string) {
  const invite = await InviteModel.findOne({ tokenHash: sha256(token) });
  if (!invite || invite.status !== 'pending' || invite.expiresAt < new Date()) {
    throw notFound('Invite (it may have expired or been cancelled)');
  }
  return invite;
}

/** Preview for the landing screen: society, house, invited name and email. No login needed. */
publicInvitesRouter.get('/:token', validate({ params: TokenParams }), async (req, res) => {
  const invite = await findLiveInvite(req.valid!.params.token);
  if (!invite.openedAt) {
    invite.openedAt = new Date();
    await invite.save();
  }
  const [society, family] = await Promise.all([
    SocietyModel.findById(invite.societyId, { name: 1, address: 1 }).lean(),
    FamilyModel.findById(invite.familyId, { unitNumber: 1, occupancy: 1 }).lean(),
  ]);
  res.json({
    societyName: society?.name,
    city: society?.address?.city,
    unitNumber: family?.unitNumber,
    occupancy: family?.occupancy,
    name: invite.name,
    email: invite.email, // pre-fills sign-in; only someone holding the link sees it
    expiresAt: invite.expiresAt,
  });
});

type UserLite = { _id: Types.ObjectId; email: string; name: string; phone?: string | null; save: () => Promise<unknown> };

/** Makes the user an ACTIVE resident of the invited house and closes the invite. */
async function joinViaInvite(invite: InviteDoc, user: UserLite) {
  const family = await FamilyModel.findOne({ _id: invite.familyId, isActive: true }).lean();
  if (!family) throw notFound('House');

  let membership = await MembershipModel.findOne({ userId: user._id, societyId: invite.societyId });
  if (membership?.status === 'active') throw conflict('ALREADY_MEMBER', 'You are already a member of this society');
  const fields = { status: 'active' as const, familyId: invite.familyId, role: 'resident' as const, approvedBy: invite.invitedBy, approvedAt: new Date() };
  membership = membership
    ? await membership.set(fields).save()
    : await MembershipModel.create({ userId: user._id, societyId: invite.societyId, ...fields });

  invite.set({ status: 'accepted', acceptedBy: user._id, acceptedAt: new Date() });
  await invite.save();
  if (!user.phone && invite.phone) {
    user.phone = invite.phone;
    await user.save();
  }

  await notify({
    userIds: [...(await adminUserIds(invite.societyId)), invite.invitedBy],
    societyId: invite.societyId,
    type: 'invite_accepted',
    title: 'Invite accepted',
    body: `${user.name} joined as a resident of ${family.unitNumber}.`,
    excludeUserId: user._id,
  });
  return membership;
}

/**
 * Accepts every live invite sent to the signed-in user's email. Called right after sign-in:
 * the code was emailed to this address, so it already proves they own it. This is what makes
 * "invited, then signs in" work even when the invite link can't open the app.
 */
publicInvitesRouter.post('/accept-pending', authenticate, async (req, res) => {
  const user = await UserModel.findById(req.userId, { email: 1, name: 1, phone: 1 });
  if (!user) throw notFound('User');
  const invites = await InviteModel.find({ email: user.email, status: 'pending', expiresAt: { $gte: new Date() } }).sort({ createdAt: 1 });
  const joined: unknown[] = [];
  for (const invite of invites) {
    try {
      joined.push(await joinViaInvite(invite, user));
    } catch {
      /* already a member, or the house was removed: skip it */
    }
  }
  res.json({ accepted: joined.length, memberships: joined });
});

/** The signed-in user (whose email must match the invite) joins as an ACTIVE resident of the house. */
publicInvitesRouter.post('/:token/accept', authenticate, validate({ params: TokenParams }), async (req, res) => {
  const invite = await findLiveInvite(req.valid!.params.token);
  const user = await UserModel.findById(req.userId, { email: 1, name: 1, phone: 1 });
  if (!user || user.email !== invite.email) {
    throw forbidden('EMAIL_MISMATCH', `This invite was sent to ${invite.email}. Sign in with that email.`);
  }
  res.json({ membership: await joinViaInvite(invite, user) });
});
