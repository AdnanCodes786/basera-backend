import { Types } from 'mongoose';
import { DueModel } from '../../models/due.js';
import { FamilyModel, OCCUPIED } from '../../models/family.js';
import { PaymentModel } from '../../models/payment.js';
import { SocietyModel } from '../../models/society.js';
import { istDayDiff, istMidnight } from '../../utils/dates.js';
import { badRequest, notFound } from '../../utils/errors.js';

type Id = Types.ObjectId | string;

/**
 * Creates the month's due for every active family that doesn't have one yet.
 * Safe to run any number of times: the unique (familyId, period) index plus $setOnInsert
 * means an existing due is never touched.
 */
export async function generateDues(societyId: Id, period: string): Promise<{ created: number; skipped: number }> {
  const society = await SocietyModel.findById(societyId).lean();
  if (!society) throw notFound('Society');
  const plan = society.maintenance;
  if (!plan) throw badRequest('NO_PLAN', 'Set the maintenance plan first');
  if (plan.startPeriod && period < plan.startPeriod) {
    throw badRequest('BEFORE_START', `Billing starts from ${plan.startPeriod}`);
  }

  const [y, m] = period.split('-').map(Number);
  const dueDate = istMidnight(y, m, plan.dueDay ?? 10);
  const filter: Record<string, unknown> = { societyId, isActive: true, ...OCCUPIED };
  const families = await FamilyModel.find(filter, { maintenanceAmount: 1 }).lean();

  const ops = families
    .map((f) => ({ familyId: f._id, amount: f.maintenanceAmount ?? plan.amount ?? 0 }))
    .filter((f) => f.amount > 0)
    .map((f) => ({
      updateOne: {
        filter: { familyId: f.familyId, period },
        update: {
          $setOnInsert: {
            societyId: new Types.ObjectId(String(societyId)),
            familyId: f.familyId,
            period,
            amount: f.amount,
            dueDate,
            amountPaid: 0,
            status: 'pending',
            reminderCount: 0,
          },
        },
        upsert: true,
      },
    }));

  if (ops.length === 0) return { created: 0, skipped: families.length };
  const result = await DueModel.bulkWrite(ops, { ordered: false });
  return { created: result.upsertedCount, skipped: families.length - result.upsertedCount };
}

/** Re-sums confirmed payments onto the due and sets pending / partial / paid. Waived dues stay waived. */
export async function recalcDue(dueId: Id): Promise<void> {
  const due = await DueModel.findById(dueId);
  if (!due) return;
  const [agg] = await PaymentModel.aggregate<{ total: number }>([
    { $match: { dueId: new Types.ObjectId(String(dueId)), status: 'confirmed' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  due.amountPaid = agg?.total ?? 0;
  if (due.status !== 'waived') {
    due.status = due.amountPaid >= due.amount ? 'paid' : due.amountPaid > 0 ? 'partial' : 'pending';
  }
  await due.save();
}

export function isOverdue(due: { status: string; dueDate: Date }, now = new Date()): boolean {
  return (due.status === 'pending' || due.status === 'partial') && istDayDiff(due.dueDate, now) > 0;
}

export function dueView(due: InstanceType<typeof DueModel> | Record<string, any>, now = new Date()) {
  const json = typeof (due as any).toJSON === 'function' ? (due as any).toJSON() : { ...due, id: due._id };
  delete json._id;
  return {
    ...json,
    balance: Math.max(0, json.amount - json.amountPaid),
    isOverdue: isOverdue(json, now),
    daysOverdue: isOverdue(json, now) ? istDayDiff(json.dueDate, now) : 0,
  };
}
