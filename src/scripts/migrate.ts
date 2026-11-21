/**
 * One-time clean-up after the switch from phone + password to email + code.
 *
 *   npm run db:migrate                                   → shows what would change (changes nothing)
 *   npm run db:migrate -- --yes                          → does it
 *   npm run db:migrate -- --yes --link 9876543210=you@gmail.com
 *        → gives the old phone account that email, so you keep its society and data
 *
 * What it does:
 *  1. Old users without an email get the --link email, or a placeholder
 *     "old-<id>@basera.invalid" (they can no longer sign in; their history stays).
 *  2. Old password fields are removed.
 *  3. Every collection's indexes are made to match the code (old ones dropped, new ones built).
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { env } from '../config/env.js';
import '../models/index.js';
import { UserModel } from '../models/user.js';
import { normalizePhone } from '../utils/phone.js';

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const links = new Map<string, string>();
args.forEach((a, i) => {
  if (a === '--link' && args[i + 1]) {
    const [phone, email] = args[i + 1].split('=');
    const p = normalizePhone(phone ?? '');
    if (p && email?.includes('@')) links.set(p, email.trim().toLowerCase());
  }
});

await connectDb(env.MONGODB_URI);
try {
  const users = mongoose.connection.collection('users');
  const old = await users.find({ $or: [{ email: { $exists: false } }, { email: null }, { email: '' }] }).toArray();

  console.log(`\nUsers without an email (from the old phone login): ${old.length}`);
  for (const u of old) {
    const target = (u.phone && links.get(u.phone)) || `old-${u._id}@basera.invalid`;
    console.log(`  ${u.name ?? '?'} (${u.phone ?? 'no phone'}) → ${target}`);
  }
  for (const [phone, email] of links) {
    if (await UserModel.exists({ email })) console.log(`  ! ${email} already belongs to another account; ${phone} gets a placeholder instead`);
  }

  if (!apply) {
    console.log('\nNothing changed. Run again with --yes to apply.\n');
  } else {
    for (const u of old) {
      let email = (u.phone && links.get(u.phone)) || `old-${u._id}@basera.invalid`;
      if (await users.findOne({ email, _id: { $ne: u._id } })) email = `old-${u._id}@basera.invalid`;
      await users.updateOne({ _id: u._id }, { $set: { email } });
    }
    const pw = await users.updateMany({}, { $unset: { passwordHash: '', resetCodeHash: '', resetCodeExpiresAt: '', resetCodeAttempts: '' } });
    console.log(`\nUpdated ${old.length} user(s); removed old password fields from ${pw.modifiedCount}.`);

    for (const model of Object.values(mongoose.models)) {
      const dropped = await model.syncIndexes();
      console.log(`  indexes ok: ${model.collection.collectionName}${dropped.length ? ` (removed old: ${dropped.join(', ')})` : ''}`);
    }
    console.log('\nDone. Start the backend with `npm run dev`.\n');
  }
} finally {
  await disconnectDb();
}
