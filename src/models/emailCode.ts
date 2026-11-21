import { Schema, model } from 'mongoose';

/** One live sign-in code per email and purpose. Only a hash is stored; MongoDB deletes it after expiry. */
const emailCodeSchema = new Schema(
  {
    email: { type: String, required: true },
    purpose: { type: String, enum: ['login', 'delete_account'], required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

emailCodeSchema.index({ email: 1, purpose: 1 }, { unique: true });
emailCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailCodeModel = model('EmailCode', emailCodeSchema);
