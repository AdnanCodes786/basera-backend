import type { RequestHandler } from 'express';
import { can, type Permission, type Role } from '../config/permissions.js';
import { forbidden, unauthorized } from '../utils/errors.js';

/** Allows the request only if the member's role has the permission (see config/permissions.ts). */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.membership) throw unauthorized();
    if (!can(req.membership.role, permission)) {
      throw forbidden('WRONG_ROLE', 'Your role cannot do this');
    }
    next();
  };
}

/** Lower-level variant when a route needs an explicit role list. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.membership) throw unauthorized();
    if (!roles.includes(req.membership.role)) throw forbidden('WRONG_ROLE', 'Your role cannot do this');
    next();
  };
}
