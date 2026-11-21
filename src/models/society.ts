import { Schema, model, type InferSchemaType } from 'mongoose';

const contactSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    service: { type: String, required: true, trim: true },
    phone: { type: String, required: true },
  },
  { _id: false },
);

const societySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    address: {
      line1: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
    },
    joinCode: { type: String, required: true, unique: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true }, // one society per head account
    settings: {
      complaintSlaHours: { type: Number, default: 48, min: 1 },
    },
    maintenance: {
      amount: { type: Number, default: 0, min: 0 }, // paise
      dueDay: { type: Number, default: 10, min: 1, max: 28 },
      generateOnDay: { type: Number, default: 1, min: 1, max: 28 },
      reminderDaysBefore: { type: [Number], default: [3, 1] },
      overdueReminderEveryDays: { type: Number, default: 3, min: 1 },
      isActive: { type: Boolean, default: false },
      startPeriod: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    },
    finance: {
      openingBalance: { type: Number, default: 0 }, // paise
      openingBalanceDate: { type: Date },
    },
    contacts: { type: [contactSchema], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type Society = InferSchemaType<typeof societySchema>;
export const SocietyModel = model('Society', societySchema);
