import { Schema, model, type InferSchemaType } from 'mongoose';

/** One row per logged-in device. Stores only a SHA-256 hash of the refresh token. */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    deviceInfo: { type: String, maxlength: 200 },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    // Only a token revoked by 'rotation' signals theft when it is presented again.
    revokedReason: { type: String, enum: ['rotation', 'logout', 'reuse_detected'] },
  },
  { timestamps: true },
);

// TTL index: MongoDB deletes the row once expiresAt passes.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type Session = InferSchemaType<typeof sessionSchema>;
export const SessionModel = model('Session', sessionSchema);
