import { Schema, model, type InferSchemaType } from 'mongoose';

const inviteSchema = new Schema(
  {
    societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', required: true },
    email: { type: String, required: true, lowercase: true, trim: true }, // only this email can accept
    name: { type: String, required: true, trim: true },
    phone: { type: String }, // optional, for the directory
    tokenHash: { type: String, required: true, unique: true }, // raw token only travels in the link
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'accepted', 'revoked', 'expired'], default: 'pending' },
    expiresAt: { type: Date, required: true },
    openedAt: { type: Date }, // first time the link preview was opened
    acceptedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    acceptedAt: { type: Date },
  },
  { timestamps: true },
);

inviteSchema.index({ societyId: 1, status: 1 });
inviteSchema.index({ email: 1, status: 1 });
inviteSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_d, ret: Record<string, unknown>) => {
    delete ret._id;
    delete ret.tokenHash;
    return ret;
  },
});

export type Invite = InferSchemaType<typeof inviteSchema>;
export const InviteModel = model('Invite', inviteSchema);
