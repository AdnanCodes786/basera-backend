import { Schema, model, type InferSchemaType } from 'mongoose';

export const NOTIFICATION_TYPES = [
  'due_reminder', 'due_overdue', 'payment_recorded', 'payment_reported', 'payment_verified', 'payment_rejected',
  'complaint_new', 'complaint_update', 'complaint_comment', 'complaint_sla_breach',
  'join_request', 'join_approved', 'invite_accepted', 'role_changed',
  'notice_posted', 'statement_ready', 'document_shared', 'admin_digest',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** The in-app inbox: one row per recipient. */
const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    societyId: { type: Schema.Types.ObjectId, ref: 'Society', default: null },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} }, // e.g. { complaintId } so the app opens the right screen
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 }); // 180 days

export type Notification = InferSchemaType<typeof notificationSchema>;
export const NotificationModel = model('Notification', notificationSchema);
