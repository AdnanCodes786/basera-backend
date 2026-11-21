import type { Types } from 'mongoose';
import { ADMIN_ROLES } from '../config/permissions.js';
import { MembershipModel } from '../models/membership.js';

type Id = Types.ObjectId | string;

/** Active app users linked to a family. */
export async function familyMemberUserIds(societyId: Id, familyId: Id): Promise<Types.ObjectId[]> {
  const rows = await MembershipModel.find({ societyId, familyId, status: 'active' }, { userId: 1 }).lean();
  return rows.map((r) => r.userId);
}

/** Chief, secretary and treasurer of a society. */
export async function adminUserIds(societyId: Id): Promise<Types.ObjectId[]> {
  const rows = await MembershipModel.find(
    { societyId, status: 'active', role: { $in: ADMIN_ROLES } },
    { userId: 1 },
  ).lean();
  return rows.map((r) => r.userId);
}

/** Every active member of a society. */
export async function allMemberUserIds(societyId: Id): Promise<Types.ObjectId[]> {
  const rows = await MembershipModel.find({ societyId, status: 'active' }, { userId: 1 }).lean();
  return rows.map((r) => r.userId);
}
