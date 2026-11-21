import type { Request } from 'express';
import { Types } from 'mongoose';
import { isAdminRole } from '../config/permissions.js';
import { FamilyModel } from '../models/family.js';
import { UserModel } from '../models/user.js';
import { forbidden, notFound } from './errors.js';

/** The verified membership set by societyGuard. */
export function member(req: Request) {
  if (!req.membership) throw forbidden();
  return req.membership;
}

export function isAdmin(req: Request): boolean {
  return isAdminRole(member(req).role);
}

export function userOid(req: Request): Types.ObjectId {
  return new Types.ObjectId(req.userId);
}

/** Loads a family of THIS society (404 otherwise). */
export async function loadFamily(req: Request, familyId: string, opts: { activeOnly?: boolean } = {}) {
  const family = await FamilyModel.findOne({
    _id: familyId,
    societyId: member(req).societyId,
    ...(opts.activeOnly ? { isActive: true } : {}),
  });
  if (!family) throw notFound('Family');
  return family;
}

/** True when the caller is the head of the given family (their email is the family's head email). */
export async function isFamilyHead(req: Request, family: { _id: unknown; head?: { email?: string | null } | null }) {
  const m = member(req);
  if (!m.familyId || String(m.familyId) !== String(family._id)) return false;
  const user = await UserModel.findById(req.userId, { email: 1 }).lean();
  return Boolean(user && family.head?.email && family.head.email === user.email);
}

/** Residents may only touch their own family's records; admins may touch any. */
export function assertOwnFamilyOrAdmin(req: Request, familyId: unknown) {
  if (isAdmin(req)) return;
  const m = member(req);
  if (!m.familyId || String(m.familyId) !== String(familyId)) {
    throw forbidden('NOT_YOUR_FAMILY', 'You can only see your own family’s records');
  }
}
