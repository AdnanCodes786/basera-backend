import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { ADMIN_ROLES, ROLES } from '../../config/permissions.js';
import { requirePermission } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { MEMBERSHIP_STATUSES, MembershipModel } from '../../models/membership.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { loadFamily, member } from '../../utils/access.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { PaginationQuery, pageResult, skipFor } from '../../utils/pagination.js';
import { ObjectIdSchema } from '../../utils/schemas.js';

/** Mounted at /societies/:societyId/members */
export const membersRouter = Router({ mergeParams: true });

const IdParams = z.object({ membershipId: ObjectIdSchema });

async function loadMembership(societyId: Types.ObjectId, membershipId: string) {
  const m = await MembershipModel.findOne({ _id: membershipId, societyId });
  if (!m) throw notFound('Member');
  return m;
}

const ListQuery = PaginationQuery.extend({
  status: z.enum(MEMBERSHIP_STATUSES).optional(),
  role: z.enum(ROLES).optional(),
});

membersRouter.get('/', requirePermission('members.view'), validate({ query: ListQuery }), async (req, res) => {
  const q = req.valid!.query as z.infer<typeof ListQuery>;
  const filter: Record<string, unknown> = { societyId: member(req).societyId };
  filter.status = q.status ?? { $in: ['pending', 'active'] };
  if (q.role) filter.role = q.role;

  const [rows, total] = await Promise.all([
    MembershipModel.find(filter)
      .sort({ status: 1, createdAt: -1 })
      .skip(skipFor(q))
      .limit(q.limit)
      .populate<{ userId: { _id: unknown; name: string; email: string; phone?: string } }>('userId', 'name email phone')
      .populate<{ familyId: { _id: unknown; unitNumber: string } | null }>('familyId', 'unitNumber')
      .lean(),
    MembershipModel.countDocuments(filter),
  ]);

  res.json(
    pageResult(
      rows.map((m) => ({
        id: m._id,
        role: m.role,
        status: m.status,
        requestedUnit: m.requestedUnit,
        user: m.userId ? { id: m.userId._id, name: m.userId.name, email: m.userId.email, phone: m.userId.phone } : null,
        family: m.familyId ? { id: m.familyId._id, unitNumber: m.familyId.unitNumber } : null,
        joinedAt: m.approvedAt ?? m.createdAt,
      })),
      total,
      q,
    ),
  );
});

const ApproveBody = z.strictObject({ familyId: ObjectIdSchema });

membersRouter.post(
  '/:membershipId/approve',
  requirePermission('members.approve'),
  validate({ params: IdParams, body: ApproveBody }),
  async (req, res) => {
    const { societyId } = member(req);
    const m = await loadMembership(societyId, req.valid!.params.membershipId);
    if (m.status !== 'pending') throw conflict('NOT_PENDING', 'This request is not pending');
    const family = await loadFamily(req, req.valid!.body.familyId, { activeOnly: true });

    m.set({ status: 'active', familyId: family._id, approvedBy: req.userId, approvedAt: new Date() });
    await m.save();
    await audit({ societyId, actorId: req.userId!, action: 'member.approved', entity: 'membership', entityId: m._id, after: { familyId: family._id } });
    await notify({
      userIds: [m.userId], societyId, type: 'join_approved',
      title: 'Request approved', body: `You have joined as a resident of ${family.unitNumber}.`,
    });
    res.json({ membership: m });
  },
);

const RejectBody = z.strictObject({ reason: z.string().trim().max(300).optional() });

membersRouter.post(
  '/:membershipId/reject',
  requirePermission('members.approve'),
  validate({ params: IdParams, body: RejectBody }),
  async (req, res) => {
    const { societyId } = member(req);
    const m = await loadMembership(societyId, req.valid!.params.membershipId);
    if (m.status !== 'pending') throw conflict('NOT_PENDING', 'This request is not pending');
    m.status = 'rejected';
    await m.save();
    await audit({ societyId, actorId: req.userId!, action: 'member.rejected', entity: 'membership', entityId: m._id, after: req.valid!.body });
    res.json({ membership: m });
  },
);

const RoleBody = z.strictObject({ role: z.enum(ROLES) });

/**
 * Chief assigns roles. Each admin role has one holder (assumption A4): giving it to someone
 * moves the previous holder back to resident. Handing over "chief" makes the old chief a resident.
 */
membersRouter.patch(
  '/:membershipId/role',
  requirePermission('roles.assign'),
  validate({ params: IdParams, body: RoleBody }),
  async (req, res) => {
    const { societyId, id: myMembershipId } = member(req);
    const { role } = req.valid!.body as z.infer<typeof RoleBody>;
    const target = await loadMembership(societyId, req.valid!.params.membershipId);
    if (target.status !== 'active') throw badRequest('NOT_ACTIVE', 'Only active members can get a role');
    if (target.role === role) return res.json({ membership: target });
    if (target._id.equals(myMembershipId) && role !== 'chief') {
      throw badRequest('CHIEF_REQUIRED', 'Give the chief role to someone else first; that moves you to resident');
    }

    const previousHolder =
      ADMIN_ROLES.includes(role) &&
      (await MembershipModel.findOneAndUpdate(
        { societyId, role, status: 'active', _id: { $ne: target._id } },
        { $set: { role: 'resident' } },
        { returnDocument: 'after' },
      ));

    const oldRole = target.role;
    target.role = role;
    await target.save();

    await audit({
      societyId, actorId: req.userId!, action: 'role.changed', entity: 'membership', entityId: target._id,
      before: { role: oldRole }, after: { role, previousHolder: previousHolder ? previousHolder._id : null },
    });
    await notify({
      userIds: [target.userId], societyId, type: 'role_changed',
      title: 'Your role changed', body: `You are now ${role} of the society.`,
    });
    if (previousHolder) {
      await notify({
        userIds: [previousHolder.userId], societyId, type: 'role_changed',
        title: 'Your role changed', body: `The ${role} role has moved to another member. You are now a resident.`,
      });
    }
    res.json({ membership: target, previousHolder: previousHolder || null });
  },
);

membersRouter.delete('/:membershipId', requirePermission('members.approve'), validate({ params: IdParams }), async (req, res) => {
  const { societyId } = member(req);
  const m = await loadMembership(societyId, req.valid!.params.membershipId);
  if (m.role === 'chief') throw badRequest('CANNOT_REMOVE_CHIEF', 'Hand over the chief role before removing this member');
  m.status = 'left';
  m.role = 'resident';
  await m.save();
  await audit({ societyId, actorId: req.userId!, action: 'member.removed', entity: 'membership', entityId: m._id });
  res.status(204).end();
});

