import { Schema, model, type InferSchemaType } from 'mongoose';
import { ROLES } from '../config/permissions.js';

export const MEMBERSHIP_STATUSES = ['pending', 'active', 'rejected', 'left'] as const;

/** A user's relationship to one society: role, family and join status. */
const membershipSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', default: null },
    role: { type: String, enum: ROLES, default: 'resident', required: true },
    status: { type: String, enum: MEMBERSHIP_STATUSES, default: 'pending', required: true },
    requestedUnit: { type: String, trim: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
  },
  { timestamps: true },
);

membershipSchema.index({ userId: 1, societyId: 1 }, { unique: true });
membershipSchema.index({ societyId: 1, status: 1 });
membershipSchema.index({ societyId: 1, role: 1 });
membershipSchema.index({ familyId: 1 });

export type Membership = InferSchemaType<typeof membershipSchema>;
export const MembershipModel = model('Membership', membershipSchema);
