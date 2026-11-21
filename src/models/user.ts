import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/** A person. They sign in with their email + a one-time code; phone is optional (for the directory). */
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    phone: { type: String }, // 10 digits, +91 assumed; optional
    deviceTokens: { type: [String], default: [], select: false },
    isActive: { type: Boolean, default: true },
    isPlatformAdmin: { type: Boolean, default: false, select: false },
    lastLoginAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

userSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret._id;
    delete ret.deviceTokens;
    delete ret.isPlatformAdmin;
    return ret;
  },
});

export type User = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<User>;
export const UserModel = model('User', userSchema);
