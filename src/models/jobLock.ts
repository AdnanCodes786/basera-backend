import { Schema, model } from 'mongoose';

/**
 * "Run once" keys for scheduled jobs, e.g. "statement:<societyId>:2026-10".
 * Inserting a key that already exists fails, so a job never runs twice for the same key,
 * even if two servers run jobs or the job is re-run by hand.
 */
const jobLockSchema = new Schema(
  { _id: { type: String, required: true } },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
jobLockSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

export const JobLockModel = model('JobLock', jobLockSchema);

/** Returns true the first time a key is claimed, false afterwards. */
export async function claimOnce(key: string): Promise<boolean> {
  try {
    await JobLockModel.create({ _id: key });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}
