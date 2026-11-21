import { Schema, model, type InferSchemaType } from 'mongoose';

const noticeSchema = new Schema(
  {
    societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    attachments: { type: [String], default: [] },
    isPinned: { type: Boolean, default: false },
    expiresAt: { type: Date, default: null }, // past expiry → archive tab
    postedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

noticeSchema.index({ societyId: 1, isPinned: -1, createdAt: -1 });

export type Notice = InferSchemaType<typeof noticeSchema>;
export const NoticeModel = model('Notice', noticeSchema);
