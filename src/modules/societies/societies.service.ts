import { Types } from 'mongoose';
import { isAdminRole, type Role } from '../../config/permissions.js';
import { MembershipModel } from '../../models/membership.js';
import { SocietyModel } from '../../models/society.js';
import { UserModel } from '../../models/user.js';
import { notify } from '../../services/notify.js';
import { adminUserIds } from '../../services/recipients.js';
import { conflict, notFound } from '../../utils/errors.js';
import { randomCode } from '../../utils/ids.js';
import type { CreateSocietyInput, UpdateSocietyInput } from './societies.schemas.js';

async function uniqueJoinCode(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = randomCode(8);
    if (!(await SocietyModel.exists({ joinCode: code }))) return code;
  }
  throw new Error('Could not generate a unique join code');
}

/** The society head creates the society and becomes its chief. One society per head account. */
export async function createSociety(userId: string, input: CreateSocietyInput) {
  if (await SocietyModel.exists({ createdBy: userId })) {
    throw conflict('SOCIETY_EXISTS', 'You have already created a society with this account');
  }

  const society = await SocietyModel.create({
    name: input.name,
    address: input.address,
    joinCode: await uniqueJoinCode(),
    createdBy: userId,
  });

  try {
    const membership = await MembershipModel.create({
      userId,
      societyId: society._id,
      role: 'chief',
      status: 'active',
      approvedAt: new Date(),
    });
    return { society, membership };
  } catch (err) {
    // No transactions on a standalone MongoDB; undo the society by hand.
    await SocietyModel.deleteOne({ _id: society._id });
    throw err;
  }
}

/** Society details as seen by a member. The join code is shown to admins only. */
export async function getSociety(societyId: Types.ObjectId, role: Role) {
  const society = await SocietyModel.findById(societyId);
  if (!society) throw notFound('Society');
  const json = society.toJSON() as Record<string, unknown>;
  if (!isAdminRole(role)) {
    delete json.joinCode;
    delete json.finance;
  }
  return json;
}

export async function updateSociety(societyId: Types.ObjectId, input: UpdateSocietyInput) {
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.address) for (const [k, v] of Object.entries(input.address)) set[`address.${k}`] = v;
  if (input.settings?.complaintSlaHours !== undefined) {
    set['settings.complaintSlaHours'] = input.settings.complaintSlaHours;
  }

  const society = await SocietyModel.findByIdAndUpdate(societyId, { $set: set }, { returnDocument: 'after', runValidators: true });
  if (!society) throw notFound('Society');
  return society;
}

export async function requestToJoin(userId: string, input: { joinCode: string; unitNumber: string }) {
  const society = await SocietyModel.findOne({ joinCode: input.joinCode, isActive: true });
  if (!society) throw notFound('Society with this join code');

  const existing = await MembershipModel.findOne({ userId, societyId: society._id });
  if (existing?.status === 'active') throw conflict('ALREADY_MEMBER', 'You are already a member of this society');
  if (existing?.status === 'pending') throw conflict('ALREADY_REQUESTED', 'Your request is already waiting for approval');

  const fields = {
    status: 'pending' as const,
    role: 'resident' as const,
    familyId: null,
    requestedUnit: input.unitNumber.toUpperCase(),
    approvedBy: undefined,
    approvedAt: undefined,
  };
  const membership = existing
    ? await existing.set(fields).save() // rejected / left earlier: ask again
    : await MembershipModel.create({ userId, societyId: society._id, ...fields });

  const user = await UserModel.findById(userId, { name: 1 }).lean();
  await notify({
    userIds: await adminUserIds(society._id),
    societyId: society._id,
    type: 'join_request',
    title: 'New join request',
    body: `${user?.name ?? 'Someone'} wants to join as ${fields.requestedUnit}.`,
    data: { membershipId: String(membership._id) },
  });
  return membership;
}

export async function regenerateJoinCode(societyId: Types.ObjectId): Promise<string> {
  const joinCode = await uniqueJoinCode();
  const result = await SocietyModel.updateOne({ _id: societyId }, { $set: { joinCode } });
  if (result.matchedCount === 0) throw notFound('Society');
  return joinCode;
}
