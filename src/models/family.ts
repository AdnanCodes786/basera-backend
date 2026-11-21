import { Schema, model, type InferSchemaType } from 'mongoose';

const householdMemberSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    relation: { type: String, trim: true },
    phone: { type: String },
  },
  { _id: true },
);

/**
 * One house (unit) in the colony. A house with no head is "empty in Basera":
 * the committee added the unit but no family yet. Inviting a family into it fills the head.
 */
const familySchema = new Schema(
  {
    societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
    unitNumber: { type: String, required: true, trim: true, uppercase: true },
    head: {
      name: { type: String, trim: true },
      phone: { type: String },
      email: { type: String, trim: true, lowercase: true },
    },
    showContact: { type: Boolean, default: true },
    members: { type: [householdMemberSchema], default: [] },
    occupancy: { type: String, enum: ['owner', 'tenant'], default: 'owner' },
    maintenanceAmount: { type: Number, min: 0 }, // paise; overrides society default when set
    isActive: { type: Boolean, default: true },
    notes: { type: String }, // admin-only
  },
  { timestamps: true },
);

familySchema.virtual('isVacant').get(function () {
  return !this.head?.name;
});

familySchema.index({ societyId: 1, unitNumber: 1 }, { unique: true });
familySchema.index({ societyId: 1, 'head.email': 1 });

export type Family = InferSchemaType<typeof familySchema>;
export const FamilyModel = model('Family', familySchema);

/** Filter for houses that have a family (dues are only raised for these). */
export const OCCUPIED: Record<string, unknown> = { 'head.name': { $type: 'string', $ne: '' } };
