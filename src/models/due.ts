import { Schema, model, type InferSchemaType } from 'mongoose';

/** One record per family per month. "Overdue" is computed (dueDate passed and not paid), never stored. */
const dueSchema = new Schema(
  {
    societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', required: true },
    period: { type: String, required: true }, // "YYYY-MM"
    amount: { type: Number, required: true, min: 0 }, // paise, copied at generation time
    dueDate: { type: Date, required: true },
    amountPaid: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'partial', 'paid', 'waived'], default: 'pending' },
    waivedReason: { type: String },
    waivedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reminderCount: { type: Number, default: 0 },
    overdueReminderCount: { type: Number, default: 0 }, // capped so nobody is spammed for a year-old due
    lastReminderAt: { type: Date },
  },
  { timestamps: true },
);

dueSchema.index({ familyId: 1, period: 1 }, { unique: true });
dueSchema.index({ societyId: 1, period: 1, status: 1 });
dueSchema.index({ status: 1, dueDate: 1 });

export type Due = InferSchemaType<typeof dueSchema>;
export const DueModel = model('Due', dueSchema);
