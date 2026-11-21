import { Schema, model, type InferSchemaType } from 'mongoose';
import { PAYMENT_MODES } from '../utils/schemas.js';

/**
 * Money coming in. kind=maintenance is linked to a due; kind=other_income (hall rent, donation)
 * has no due and needs a title. Never hard-deleted: mistakes are rejected or voided.
 */
const paymentSchema = new Schema(
  {
    societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', default: null },
    dueId: { type: Schema.Types.ObjectId, ref: 'Due', default: null },
    kind: { type: String, enum: ['maintenance', 'other_income'], default: 'maintenance' },
    title: { type: String, trim: true, maxlength: 150 },
    amount: { type: Number, required: true, min: 1 }, // paise
    mode: { type: String, enum: PAYMENT_MODES, required: true },
    reference: { type: String, trim: true, maxlength: 100 },
    paidOn: { type: Date, required: true },
    status: {
      type: String,
      enum: ['confirmed', 'pending_verification', 'rejected', 'voided'],
      required: true,
    },
    source: { type: String, enum: ['admin_entry', 'resident_report'], required: true },
    screenshotUrl: { type: String },
    receiptNumber: { type: Number }, // set when confirmed
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
    rejectionReason: { type: String },
    voidReason: { type: String },
    note: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);

paymentSchema.index({ societyId: 1, status: 1, createdAt: -1 });
paymentSchema.index({ dueId: 1 });
paymentSchema.index({ familyId: 1, paidOn: -1 });
paymentSchema.index({ societyId: 1, status: 1, paidOn: 1 });

export type Payment = InferSchemaType<typeof paymentSchema>;
export const PaymentModel = model('Payment', paymentSchema);
