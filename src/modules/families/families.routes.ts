import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ADMIN_ROLES } from '../../config/permissions.js';
import { requirePermission } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { FamilyModel, OCCUPIED } from '../../models/family.js';
import { InviteModel } from '../../models/invite.js';
import { MembershipModel } from '../../models/membership.js';
import { audit, diff } from '../../services/audit.js';
import { isAdmin, isFamilyHead, loadFamily, member } from '../../utils/access.js';
import { conflict, forbidden } from '../../utils/errors.js';
import { PaginationQuery, pageResult, skipFor } from '../../utils/pagination.js';
import { PhoneSchema } from '../../utils/phone.js';
import { ObjectIdSchema, PaiseOrZero, escapeRegex } from '../../utils/schemas.js';

/** Mounted at /societies/:societyId/families */
export const familiesRouter = Router({ mergeParams: true });

type FamilyDoc = InstanceType<typeof FamilyModel>;

const HouseholdMember = z.strictObject({
  name: z.string().trim().min(1).max(100),
  relation: z.string().trim().max(50).optional(),
  phone: PhoneSchema.optional(),
});

const Head = z.strictObject({
  name: z.string().trim().min(2).max(100),
  email: z.email().trim().toLowerCase().optional(),
  phone: PhoneSchema.optional(),
});

/** A house: only unitNumber is required. Without `head` it is an empty house waiting for a family. */
const FamilyBody = z.strictObject({
  unitNumber: z.string().trim().min(1).max(30),
  head: Head.optional(),
  members: z.array(HouseholdMember).max(30).optional(),
  occupancy: z.enum(['owner', 'tenant']).optional(),
  maintenanceAmount: PaiseOrZero.nullable().optional(),
  showContact: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});

const IdParams = z.object({ familyId: ObjectIdSchema });

/** "A-14" → "A", "House 12" → "House". Used by the app to group the directory. */
function blockOf(unit: string): string {
  const m = unit.match(/^([A-Z]+)[-\s]?\d/);
  return m ? m[1] : unit.split(/[-\s]/)[0];
}

/** Committee roles held by each family's members: { familyId: ['chief'] } */
async function rolesByFamily(societyId: Types.ObjectId) {
  const rows = await MembershipModel.find(
    { societyId, status: 'active', role: { $in: ADMIN_ROLES }, familyId: { $ne: null } },
    { familyId: 1, role: 1 },
  ).lean();
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(String(r.familyId), [...(map.get(String(r.familyId)) ?? []), r.role]);
  return map;
}

/** What any member sees about another family: no notes, phone hidden if the family chose so. */
function directoryView(f: FamilyDoc, opts: { canSeePhone: boolean; roles?: string[]; isMine: boolean }) {
  return {
    id: f.id,
    unitNumber: f.unitNumber,
    block: blockOf(f.unitNumber),
    head: { name: f.head?.name, phone: opts.canSeePhone || f.showContact ? (f.head?.phone ?? null) : null },
    phoneHidden: !f.showContact,
    occupancy: f.occupancy,
    roles: opts.roles ?? [],
    isMine: opts.isMine,
  };
}

const ListQuery = PaginationQuery.extend({
  search: z.string().trim().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** The neighbours directory: families only (empty houses are left out), sorted by house. */
familiesRouter.get('/', requirePermission('families.view'), validate({ query: ListQuery }), async (req, res) => {
  const q = req.valid!.query as z.infer<typeof ListQuery>;
  const m = member(req);
  const admin = isAdmin(req);
  const filter: Record<string, unknown> = { societyId: m.societyId, isActive: true, ...OCCUPIED };
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ unitNumber: rx }, { 'head.name': rx }];
  }
  const [items, total, roles] = await Promise.all([
    FamilyModel.find(filter).collation({ locale: 'en', numericOrdering: true }).sort({ unitNumber: 1 }).skip(skipFor(q)).limit(q.limit),
    FamilyModel.countDocuments(filter),
    rolesByFamily(m.societyId),
  ]);
  res.json(
    pageResult(
      items.map((f) => directoryView(f, { canSeePhone: admin, roles: roles.get(f.id), isMine: String(m.familyId) === f.id })),
      total,
      q,
    ),
  );
});

familiesRouter.post('/', requirePermission('families.manage'), validate({ body: FamilyBody }), async (req, res) => {
  const body = req.valid!.body as z.infer<typeof FamilyBody>;
  const { societyId } = member(req);
  if (await FamilyModel.exists({ societyId, unitNumber: body.unitNumber.toUpperCase() })) {
    throw conflict('UNIT_EXISTS', `House ${body.unitNumber} already exists`);
  }
  const family = await FamilyModel.create({ ...body, societyId });
  await audit({ societyId, actorId: req.userId!, action: 'family.created', entity: 'family', entityId: family._id, after: body });
  res.status(201).json({ family });
});

const ImportBody = z.strictObject({ families: z.array(FamilyBody).min(1).max(500) });

/** Bulk add houses (and families). The app turns a CSV/Excel sheet into this list. Existing units are skipped. */
familiesRouter.post('/import', requirePermission('families.manage'), validate({ body: ImportBody }), async (req, res) => {
  const { families } = req.valid!.body as z.infer<typeof ImportBody>;
  const { societyId } = member(req);
  const created: string[] = [];
  const skipped: { unitNumber: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const f of families) {
    const unit = f.unitNumber.toUpperCase();
    if (seen.has(unit) || (await FamilyModel.exists({ societyId, unitNumber: unit }))) {
      skipped.push({ unitNumber: unit, reason: 'House already exists' });
      continue;
    }
    seen.add(unit);
    await FamilyModel.create({ ...f, societyId });
    created.push(unit);
  }
  await audit({ societyId, actorId: req.userId!, action: 'family.imported', entity: 'family', after: { created } });
  res.status(201).json({ createdCount: created.length, created, skipped });
});

const OverviewQuery = z.object({
  status: z.enum(['joined', 'invited', 'not_invited', 'empty']).optional(),
});

/**
 * Committee "Members" screen: every house with its Basera status.
 *   empty       → house added, no family yet
 *   not_invited → family known, nobody invited
 *   invited     → invite sent, not accepted (with when, and whether the link was opened)
 *   joined      → at least one person from the family uses Basera
 */
familiesRouter.get('/overview', requirePermission('members.view'), validate({ query: OverviewQuery }), async (req, res) => {
  const { societyId } = member(req);
  const wanted = (req.valid!.query as z.infer<typeof OverviewQuery>).status;
  const now = new Date();
  const [families, memberships, invites, roles] = await Promise.all([
    FamilyModel.find({ societyId, isActive: true }).collation({ locale: 'en', numericOrdering: true }).sort({ unitNumber: 1 }),
    MembershipModel.find({ societyId, status: 'active', familyId: { $ne: null } }, { familyId: 1 }).lean(),
    InviteModel.find({ societyId, status: 'pending', expiresAt: { $gte: now } }).sort({ createdAt: -1 }).lean(),
    rolesByFamily(societyId),
  ]);
  const people = new Map<string, number>();
  for (const m of memberships) people.set(String(m.familyId), (people.get(String(m.familyId)) ?? 0) + 1);
  const latestInvite = new Map<string, (typeof invites)[number]>();
  for (const i of invites) if (!latestInvite.has(String(i.familyId))) latestInvite.set(String(i.familyId), i);

  const houses = families.map((f) => {
    const count = people.get(f.id) ?? 0;
    const invite = latestInvite.get(f.id);
    const status = count > 0 ? 'joined' : invite ? 'invited' : f.get('isVacant') ? 'empty' : 'not_invited';
    return {
      id: f.id,
      unitNumber: f.unitNumber,
      headName: f.head?.name ?? null,
      occupancy: f.occupancy,
      status,
      peopleOnBasera: count,
      roles: roles.get(f.id) ?? [],
      invite: invite ? { id: invite._id, name: invite.name, email: invite.email, sentAt: invite.createdAt, openedAt: invite.openedAt ?? null } : null,
    };
  });
  const counts = { houses: houses.length, joined: 0, invited: 0, not_invited: 0, empty: 0 } as Record<string, number>;
  for (const h of houses) counts[h.status] += 1;
  res.json({ counts, houses: wanted ? houses.filter((h) => h.status === wanted) : houses });
});

familiesRouter.get('/:familyId', requirePermission('families.view'), validate({ params: IdParams }), async (req, res) => {
  const family = await loadFamily(req, req.valid!.params.familyId);
  const m = member(req);
  const admin = isAdmin(req);
  const own = String(m.familyId) === String(family._id);
  if (!admin && !family.isActive) throw forbidden();
  if (!admin && !own) {
    const roles = await rolesByFamily(m.societyId);
    return res.json({ family: directoryView(family, { canSeePhone: false, roles: roles.get(family.id), isMine: false }) });
  }

  // Own family or admin: full record + who uses Basera + invites still pending (the Profile screen).
  const [users, invites] = await Promise.all([
    MembershipModel.find({ societyId: m.societyId, familyId: family._id, status: 'active' })
      .populate<{ userId: { _id: Types.ObjectId; name: string; email: string } }>('userId', 'name email')
      .lean(),
    InviteModel.find({ societyId: m.societyId, familyId: family._id, status: 'pending', expiresAt: { $gte: new Date() } }).lean(),
  ]);
  const json = family.toJSON() as Record<string, unknown>;
  if (!admin) delete json.notes;
  res.json({
    family: {
      ...json,
      isMine: own,
      appUsers: users.map((u) => ({ membershipId: u._id, userId: u.userId?._id, name: u.userId?.name, role: u.role, isYou: String(u.userId?._id) === req.userId, joinedAt: u.approvedAt ?? u.createdAt })),
      pendingInvites: invites.map((i) => ({ id: i._id, name: i.name, email: i.email, sentAt: i.createdAt, openedAt: i.openedAt ?? null })),
    },
  });
});

/** What a family head (non-admin) may change about their own family. */
const HeadPatchBody = z.strictObject({
  members: z.array(HouseholdMember).max(30).optional(),
  showContact: z.boolean().optional(),
  head: z.strictObject({ phone: PhoneSchema.optional() }).optional(),
});

familiesRouter.patch('/:familyId', validate({ params: IdParams }), async (req: Request, res) => {
  const family = await loadFamily(req, req.valid!.params.familyId, { activeOnly: true });
  const admin = isAdmin(req);
  if (!admin && !(await isFamilyHead(req, family))) {
    throw forbidden('NOT_FAMILY_HEAD', 'Only admins or the head of this family can edit it');
  }
  // Admins may change everything; a family head only members / showContact / head phone.
  const body = (admin ? FamilyBody.partial().parse(req.body) : HeadPatchBody.parse(req.body)) as {
    unitNumber?: string;
    head?: Record<string, unknown>;
    [key: string]: unknown;
  };

  const before = family.toObject() as Record<string, unknown>;
  if (body.unitNumber && body.unitNumber.toUpperCase() !== family.unitNumber) {
    if (await FamilyModel.exists({ societyId: family.societyId, unitNumber: body.unitNumber.toUpperCase() })) {
      throw conflict('UNIT_EXISTS', `House ${body.unitNumber} already exists`);
    }
  }
  const { head, ...rest } = body;
  family.set(rest);
  if (head) for (const [k, v] of Object.entries(head)) family.set(`head.${k}`, v);
  await family.save();

  await audit({
    societyId: family.societyId, actorId: req.userId!, action: 'family.updated', entity: 'family', entityId: family._id,
    ...diff(before, family.toObject() as Record<string, unknown>),
  });
  const json = family.toJSON() as Record<string, unknown>;
  if (!admin) delete json.notes;
  res.json({ family: json });
});

/** Soft delete: the house disappears from lists and gets no new dues. History stays. */
familiesRouter.delete('/:familyId', requirePermission('families.manage'), validate({ params: IdParams }), async (req, res) => {
  const family = await loadFamily(req, req.valid!.params.familyId);
  family.isActive = false;
  await family.save();
  await audit({ societyId: family.societyId, actorId: req.userId!, action: 'family.deactivated', entity: 'family', entityId: family._id });
  res.status(204).end();
});
