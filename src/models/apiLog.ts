import { Schema, model } from 'mongoose';
import { env } from '../config/env.js';

/**
 * One row per API request (debugging). No bodies, no tokens.
 * Auto-deleted after API_LOG_TTL_DAYS so it never fills the database.
 */
const apiLogSchema = new Schema(
  {
    requestId: { type: String },
    method: { type: String },
    path: { type: String }, // URL without query string
    route: { type: String }, // matched pattern, e.g. /api/v1/societies/:societyId/complaints/:id
    query: { type: Schema.Types.Mixed },
    status: { type: Number },
    durationMs: { type: Number },
    userId: { type: Schema.Types.ObjectId, default: null },
    societyId: { type: Schema.Types.ObjectId, default: null },
    errorCode: { type: String, default: null },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

apiLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: env.API_LOG_TTL_DAYS * 24 * 60 * 60 });
apiLogSchema.index({ status: 1, createdAt: -1 });
apiLogSchema.index({ userId: 1, createdAt: -1 });
apiLogSchema.index({ requestId: 1 });

export const ApiLogModel = model('ApiLog', apiLogSchema);
