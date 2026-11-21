import type { Types } from 'mongoose';
import { logger } from '../config/logger.js';
import { AuditLogModel } from '../models/auditLog.js';

type Id = Types.ObjectId | string;

export async function audit(entry: {
  societyId?: Id | null;
  actorId: Id;
  action: string;
  entity: string;
  entityId?: Id;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  try {
    await AuditLogModel.create(entry);
  } catch (err) {
    // An audit failure must never break the user's action; it is logged loudly instead.
    logger.error({ err, entry: { action: entry.action, entityId: entry.entityId } }, 'Audit log write failed');
  }
}

/** Only the fields that changed, for compact before/after records. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a };
}
