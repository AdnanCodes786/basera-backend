import { Router } from 'express';
import { requirePermission } from '../../middleware/requireRole.js';
import { ComplaintModel } from '../../models/complaint.js';
import { DueModel } from '../../models/due.js';
import { ExpenseModel } from '../../models/expense.js';
import { InviteModel } from '../../models/invite.js';
import { MembershipModel } from '../../models/membership.js';
import { PaymentModel } from '../../models/payment.js';
import { member } from '../../utils/access.js';
import { addDays, periodOf } from '../../utils/dates.js';
import { ACTIVE_STATUSES } from '../complaints/complaints.routes.js';
import { computeStatement } from '../finance/statement.service.js';

/** Mounted at /societies/:societyId/desk: the committee's "Needs you today" screen in one call. */
export const deskRouter = Router({ mergeParams: true });

deskRouter.get('/', requirePermission('members.view'), async (req, res) => {
  const { societyId } = member(req);
  const now = new Date();
  const period = periodOf(now);
  const inviteCutoff = addDays(now, -3);

  const [dues, toConfirm, overdue, invitesWaiting, noBill, joinRequests, statement] = await Promise.all([
    DueModel.find({ societyId, period }, { status: 1, amount: 1, amountPaid: 1 }).lean(),
    PaymentModel.find({ societyId, status: 'pending_verification' }).sort({ createdAt: 1 }).limit(5).populate<{ familyId: { unitNumber: string; head?: { name?: string } } | null }>('familyId', 'unitNumber head.name').lean(),
    ComplaintModel.find({ societyId, status: { $in: ACTIVE_STATUSES }, nextUpdateDueAt: { $lte: now } }, { number: 1, title: 1, nextUpdateDueAt: 1 }).sort({ nextUpdateDueAt: 1 }).lean(),
    InviteModel.countDocuments({ societyId, status: 'pending', expiresAt: { $gte: now }, createdAt: { $lte: inviteCutoff } }),
    ExpenseModel.find({ societyId, status: 'recorded', receipts: { $size: 0 } }, { title: 1, amount: 1, spentOn: 1 }).sort({ spentOn: -1 }).lean(),
    MembershipModel.countDocuments({ societyId, status: 'pending' }),
    computeStatement(societyId, period).catch(() => null),
  ]);

  const counts = { paid: 0, partial: 0, pending: 0, waived: 0 } as Record<string, number>;
  let expected = 0;
  let collected = 0;
  for (const d of dues) {
    counts[d.status] += 1;
    if (d.status !== 'waived') expected += d.amount;
    collected += d.amountPaid;
  }
  const paymentsTotal = await PaymentModel.countDocuments({ societyId, status: 'pending_verification' });

  res.json({
    period,
    dues: { expected, collected, pending: Math.max(0, expected - collected), counts },
    fundBalance: statement?.closing ?? null,
    needsYou: {
      paymentsToConfirm: {
        count: paymentsTotal,
        items: toConfirm.map((p) => ({ id: p._id, unitNumber: p.familyId?.unitNumber, headName: p.familyId?.head?.name, amount: p.amount })),
      },
      complaintsOverdue: {
        count: overdue.length,
        items: overdue.slice(0, 3).map((c) => ({
          id: c._id, number: c.number, title: c.title,
          overdueByHours: Math.floor((now.getTime() - c.nextUpdateDueAt!.getTime()) / 3_600_000),
        })),
      },
      invitesNotAccepted: { count: invitesWaiting, olderThanDays: 3 },
      expensesWithoutBill: { count: noBill.length, items: noBill.slice(0, 3).map((e) => ({ id: e._id, title: e.title, amount: e.amount, spentOn: e.spentOn })) },
      joinRequests: { count: joinRequests },
    },
  });
});
