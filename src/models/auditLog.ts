import { Schema, model, type InferSchemaType } from 'mongoose';

/** Who changed what (payments, waivers, roles, families...). Kept permanently. */
const auditLogSchema = new Schema(
  {
    societyId: { type: Schema.Types.ObjectId, ref: 'Society', default: null },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true }, // e.g. payment.recorded, due.waived, role.changed
    entity: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ societyId: 1, createdAt: -1 });
auditLogSchema.index({ entity: 1, entityId: 1 });

export type AuditLog = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel = model('AuditLog', auditLogSchema);
