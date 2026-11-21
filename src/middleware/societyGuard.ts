import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { MembershipModel } from '../models/membership.js';
import type { Role } from '../config/permissions.js';
import { forbidden, notFound, unauthorized } from '../utils/errors.js';

/**
 * Runs on every /societies/:societyId/... route.
 * Rejects the request unless the logged-in user has an ACTIVE membership in that society,
 * then attaches it as `req.membership`.
 *
 * Rule: inside society routes, always filter by `req.membership.societyId`,
 * never by a societyId from the body or query.
 */
export const societyGuard: RequestHandler = async (req, _res, next) => {
  if (!req.userId) throw unauthorized();

  const { societyId } = req.params as { societyId?: string };
  if (!societyId || !/^[0-9a-f]{24}$/i.test(societyId)) throw notFound('Society');

  const membership = await MembershipModel.findOne({
    userId: new Types.ObjectId(req.userId),
    societyId: new Types.ObjectId(societyId),
    status: 'active',
  }).lean();

  if (!membership) throw forbidden('NOT_A_MEMBER', 'You are not a member of this society');

  req.membership = {
    id: membership._id,
    societyId: membership.societyId,
    familyId: membership.familyId ?? null,
    role: membership.role as Role,
  };
  next();
};
