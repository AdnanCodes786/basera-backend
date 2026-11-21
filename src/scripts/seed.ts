/**
 * Creates a demo society with realistic data so the app has something to show.
 *   npm run seed
 * Sign in with these emails; without RESEND_API_KEY the 6-digit code is printed in the server terminal:
 *   chief@demo.basera.app · treasurer@demo.basera.app · secretary@demo.basera.app · resident@demo.basera.app (A-101)
 * Refuses to run twice (checks for the demo chief) and refuses in production.
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { env, isProd } from '../config/env.js';
import {
  ComplaintModel, DueModel, ExpenseModel, FamilyModel, MembershipModel, NoticeModel, PaymentModel, SocietyModel, UserModel, nextSeq,
} from '../models/index.js';
import { generateDues, recalcDue } from '../modules/maintenance/dues.service.js';
import { addDays, addHours, istMidnight, periodOf, shiftPeriod } from '../utils/dates.js';
import { randomCode } from '../utils/ids.js';

if (isProd) {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

await connectDb(env.MONGODB_URI);
await Promise.all(Object.values(mongoose.models).map((m) => m.createIndexes()));

try {
  if (await UserModel.exists({ email: 'chief@demo.basera.app' })) {
    console.log('Demo data already exists (chief@demo.basera.app). Nothing to do.');
  } else {
    const mk = (name: string, role: string, phone: string) => new UserModel({ name, email: `${role}@demo.basera.app`, phone }).save();
    const chief = await mk('Demo Chief', 'chief', '9000000001');
    const treasurer = await mk('Demo Treasurer', 'treasurer', '9000000002');
    const secretary = await mk('Demo Secretary', 'secretary', '9000000003');
    const resident = await mk('Demo Resident', 'resident', '9000000004');

    const thisMonth = periodOf();
    const lastMonth = shiftPeriod(thisMonth, -1);
    const [ly, lm] = lastMonth.split('-').map(Number);

    const society = await SocietyModel.create({
      name: 'Demo Green Park Colony',
      address: { line1: 'Near City Mall', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
      joinCode: randomCode(8),
      createdBy: chief._id,
      maintenance: { amount: 200000, dueDay: 10, generateOnDay: 1, isActive: true, startPeriod: lastMonth },
      finance: { openingBalance: 5000000, openingBalanceDate: istMidnight(ly, lm, 1) },
      contacts: [
        { name: 'Raju', service: 'Plumber', phone: '9876500001' },
        { name: 'Sunil', service: 'Electrician', phone: '9876500002' },
      ],
    });
    const sid = society._id;

    const families = await FamilyModel.insertMany(
      ['A-101', 'A-102', 'A-103', 'B-201', 'B-202', 'B-203'].map((unit, i) => ({
        societyId: sid,
        unitNumber: unit,
        head: {
          name: i === 0 ? 'Demo Resident' : `Head of ${unit}`,
          phone: i === 0 ? '9000000004' : `98765100${10 + i}`,
          email: i === 0 ? 'resident@demo.basera.app' : undefined,
        },
        occupancy: i % 3 === 2 ? 'tenant' : 'owner',
        ...(unit.startsWith('B') ? { maintenanceAmount: 250000 } : {}),
      })),
    );

    const roles: [typeof chief, string, number][] = [[chief, 'chief', 1], [treasurer, 'treasurer', 2], [secretary, 'secretary', 3], [resident, 'resident', 0]];
    await MembershipModel.insertMany(
      roles.map(([u, role, fi]) => ({ userId: u._id, societyId: sid, familyId: families[fi]._id, role, status: 'active', approvedAt: new Date() })),
    );

    // Two months of dues; everyone paid last month except B-203, half paid this month.
    await generateDues(sid, lastMonth);
    await generateDues(sid, thisMonth);
    const dues = await DueModel.find({ societyId: sid });
    for (const due of dues) {
      const unit = families.find((f) => f._id.equals(due.familyId))!.unitNumber;
      const pay = due.period === lastMonth ? unit !== 'B-203' : ['A-101', 'A-102', 'B-201'].includes(unit);
      if (!pay) continue;
      await PaymentModel.create({
        societyId: sid, familyId: due.familyId, dueId: due._id, kind: 'maintenance', amount: due.amount,
        mode: unit.startsWith('A') ? 'upi' : 'cash', reference: unit.startsWith('A') ? `UPI${Math.floor(Math.random() * 1e9)}` : undefined,
        paidOn: new Date(Math.min(addDays(due.dueDate, -2).getTime(), Date.now())), status: 'confirmed', source: 'admin_entry',
        recordedBy: treasurer._id, verifiedBy: treasurer._id, verifiedAt: new Date(), receiptNumber: await nextSeq(`${sid}:receipt`),
      });
      await recalcDue(due._id);
    }

    const lmDay = (d: number) => istMidnight(ly, lm, d);
    await ExpenseModel.insertMany([
      { societyId: sid, title: 'Security guard salary', category: 'security', amount: 1200000, spentOn: lmDay(5), paidTo: 'SafeGuard Agency', mode: 'bank_transfer', recordedBy: treasurer._id },
      { societyId: sid, title: 'Common area electricity', category: 'electricity', amount: 340000, spentOn: lmDay(12), paidTo: 'MSEDCL', mode: 'upi', recordedBy: treasurer._id },
      { societyId: sid, title: 'Garden maintenance', category: 'gardening', amount: 150000, spentOn: lmDay(20), paidTo: 'Ramesh', mode: 'cash', recordedBy: secretary._id },
    ]);

    const now = new Date();
    await ComplaintModel.create([
      {
        societyId: sid, number: await nextSeq(`${sid}:complaint`), title: 'No water in A block since morning', category: 'water', priority: 'high',
        raisedBy: resident._id, familyId: families[0]._id, status: 'acknowledged',
        history: [{ status: 'open', by: resident._id, at: addHours(now, -30) }, { status: 'acknowledged', note: 'Plumber called', by: secretary._id, at: addHours(now, -20) }],
        lastAdminUpdateAt: addHours(now, -20), nextUpdateDueAt: addHours(now, 28),
      },
      {
        societyId: sid, number: await nextSeq(`${sid}:complaint`), title: 'Streetlight near gate not working', category: 'electricity',
        raisedBy: resident._id, familyId: families[0]._id, status: 'open',
        history: [{ status: 'open', by: resident._id, at: addHours(now, -60) }], nextUpdateDueAt: addHours(now, -12),
      },
    ]);

    await NoticeModel.create([
      { societyId: sid, title: 'Annual General Meeting', body: 'AGM on Sunday 6pm at the clubhouse. All owners please attend.', isPinned: true, postedBy: chief._id },
      { societyId: sid, title: 'Water tank cleaning', body: 'Water supply off on Saturday 10am–2pm.', postedBy: secretary._id, expiresAt: addDays(now, 5) },
    ]);

    console.log(`Demo society created: ${society.name} (join code ${society.joinCode})`);
    console.log('Sign in with chief@ / treasurer@ / secretary@ / resident@demo.basera.app (code is printed in the server terminal)');
  }
} finally {
  await disconnectDb();
}
