import { Types } from 'mongoose';
import { DueModel } from '../../models/due.js';
import { ExpenseModel } from '../../models/expense.js';
import { PaymentModel } from '../../models/payment.js';
import { SocietyModel } from '../../models/society.js';
import { periodLabel, periodOf, periodRange } from '../../utils/dates.js';
import { badRequest, notFound } from '../../utils/errors.js';

type Range = { from: Date; to: Date };

async function incomeIn(societyId: Types.ObjectId, { from, to }: Range) {
  const rows = await PaymentModel.aggregate<{ _id: string; total: number; count: number }>([
    { $match: { societyId, status: 'confirmed', paidOn: { $gte: from, $lt: to } } },
    { $group: { _id: '$kind', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const get = (k: string) => rows.find((r) => r._id === k) ?? { total: 0, count: 0 };
  return { maintenance: get('maintenance'), other: get('other_income') };
}

async function expensesIn(societyId: Types.ObjectId, { from, to }: Range) {
  const rows = await ExpenseModel.aggregate<{ _id: string; total: number; count: number }>([
    { $match: { societyId, status: 'recorded', spentOn: { $gte: from, $lt: to } } },
    { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);
  return {
    total: rows.reduce((s, r) => s + r.total, 0),
    byCategory: rows.map((r) => ({ category: r._id, total: r.total, count: r.count })),
  };
}

/**
 * Statement for one month:
 *   opening (carried forward from the society's opening balance)
 * + maintenance collected + other income
 * − expenses (non-voided)
 * = closing
 */
export async function computeStatement(societyIdInput: Types.ObjectId | string, period: string) {
  const societyId = new Types.ObjectId(String(societyIdInput));
  const society = await SocietyModel.findById(societyId, { finance: 1, name: 1 }).lean();
  if (!society) throw notFound('Society');

  const openingBalance = society.finance?.openingBalance ?? 0;
  const openingDate = society.finance?.openingBalanceDate ?? new Date(0);
  const { start, end } = periodRange(period);
  if (end <= openingDate) {
    throw badRequest('BEFORE_OPENING', `Statements start from ${periodLabel(periodOf(openingDate))}, when the opening balance was set`);
  }
  const monthStart = start > openingDate ? start : openingDate;

  const [priorIncome, priorExpenses, income, expenses] = await Promise.all([
    incomeIn(societyId, { from: openingDate, to: monthStart }),
    expensesIn(societyId, { from: openingDate, to: monthStart }),
    incomeIn(societyId, { from: monthStart, to: end }),
    expensesIn(societyId, { from: monthStart, to: end }),
  ]);

  const opening = openingBalance + priorIncome.maintenance.total + priorIncome.other.total - priorExpenses.total;
  const totalIncome = income.maintenance.total + income.other.total;
  // "Maintenance from 81 of 86 homes": this month's dues fully paid vs all billed (waived left out).
  const [homesBilled, homesPaid] = await Promise.all([
    DueModel.countDocuments({ societyId, period, status: { $ne: 'waived' } }),
    DueModel.countDocuments({ societyId, period, status: 'paid' }),
  ]);
  return {
    period,
    periodLabel: periodLabel(period),
    homes: { paid: homesPaid, billed: homesBilled },
    opening,
    income: {
      maintenance: income.maintenance.total,
      maintenancePayments: income.maintenance.count,
      other: income.other.total,
      total: totalIncome,
    },
    expenses,
    closing: opening + totalIncome - expenses.total,
  };
}
