import { Schema, model, type InferSchemaType } from 'mongoose';
import { PAYMENT_MODES } from '../utils/schemas.js';

export const EXPENSE_CATEGORIES = [
  'security', 'cleaning', 'electricity', 'water', 'repairs', 'gardening', 'salaries', 'admin', 'other',
] as const;

const expenseSchema = new Schema(
  {
    societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    amount: { type: Number, required: true, min: 1 }, // paise
    spentOn: { type: Date, required: true }, // decides which month's statement it lands in
    paidTo: { type: String, trim: true, maxlength: 150 },
    mode: { type: String, enum: PAYMENT_MODES, default: 'cash' },
    reference: { type: String, trim: true, maxlength: 100 },
    receipts: { type: [String], default: [] },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['recorded', 'voided'], default: 'recorded' },
    voidReason: { type: String },
    voidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

expenseSchema.index({ societyId: 1, spentOn: 1 });
expenseSchema.index({ societyId: 1, category: 1, spentOn: 1 });

export type Expense = InferSchemaType<typeof expenseSchema>;
export const ExpenseModel = model('Expense', expenseSchema);
