import { Schema, model, type InferSchemaType } from 'mongoose';

export const COMPLAINT_CATEGORIES = [
  'water', 'electricity', 'cleaning', 'security', 'lift', 'parking', 'noise', 'other',
] as const;
export const COMPLAINT_STATUSES = ['open', 'acknowledged', 'in_progress', 'resolved', 'closed', 'rejected'] as const;
export const CLOSED_STATUSES = ['resolved', 'closed', 'rejected'] as const;

const complaintSchema = new Schema(
  {
    societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
    number: { type: Number, required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 4000 },
    category: { type: String, enum: COMPLAINT_CATEGORIES, default: 'other' },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    raisedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', default: null },
    status: { type: String, enum: COMPLAINT_STATUSES, default: 'open' },
    history: [
      {
        _id: false,
        status: { type: String, enum: COMPLAINT_STATUSES },
        note: String,
        by: { type: Schema.Types.ObjectId, ref: 'User' },
        at: Date,
      },
    ],
    comments: [
      {
        by: { type: Schema.Types.ObjectId, ref: 'User' },
        text: { type: String, maxlength: 2000 },
        at: Date,
      },
    ],
    attachments: { type: [String], default: [] },
    commentCount: { type: Number, default: 0 }, // shown on the board without loading comments
    lastAdminUpdateAt: { type: Date },
    nextUpdateDueAt: { type: Date, default: null }, // null once resolved/closed/rejected
    slaBreachCount: { type: Number, default: 0 },
    lastBreachNotifiedAt: { type: Date, default: null },
    resolvedAt: { type: Date },
  },
  { timestamps: true },
);

complaintSchema.index({ societyId: 1, number: 1 }, { unique: true });
complaintSchema.index({ societyId: 1, status: 1, createdAt: -1 });
complaintSchema.index({ nextUpdateDueAt: 1 });

export type Complaint = InferSchemaType<typeof complaintSchema>;
export const ComplaintModel = model('Complaint', complaintSchema);
