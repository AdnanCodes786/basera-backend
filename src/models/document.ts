import { Schema, model, type InferSchemaType } from 'mongoose';

export const DOCUMENT_CATEGORIES = ['registration', 'bylaws', 'minutes', 'contracts', 'bills', 'audit', 'other'] as const;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Files live in a private bucket; the app only ever gets short-lived download links. */
const documentSchema = new Schema(
  {
    societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    category: { type: String, enum: DOCUMENT_CATEGORIES, default: 'other' },
    visibility: { type: String, enum: ['admins', 'residents'], required: true },
    fileKey: { type: String, required: true }, // storage public_id
    resourceType: { type: String, enum: ['image', 'raw', 'video'], default: 'raw' },
    format: { type: String }, // e.g. "pdf"
    mimeType: { type: String },
    sizeBytes: { type: Number, max: MAX_DOCUMENT_BYTES },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Set when a RESIDENT shared it with the committee (rent agreement, parking letter):
    // visible to the committee and that family only.
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', default: null },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

documentSchema.index({ societyId: 1, visibility: 1, category: 1 });
documentSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_d, ret: Record<string, unknown>) => {
    delete ret._id;
    delete ret.fileKey; // never expose the storage key; use the download endpoint
    return ret;
  },
});

export type DocumentRecord = InferSchemaType<typeof documentSchema>;
export const DocumentModel = model('Document', documentSchema);
