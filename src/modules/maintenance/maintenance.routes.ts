import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { requirePermission } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { nextSeq } from '../../models/counter.js';
import { DueModel } from '../../models/due.js';
import { FamilyModel } from '../../models/family.js';
import { PaymentModel } from '../../models/payment.js';
import { SocietyModel } from '../../models/society.js';
import { UserModel } from '../../models/user.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { adminUserIds, familyMemberUserIds } from '../../services/recipients.js';
import { isOurUpload } from '../../services/storage.js';
import { assertOwnFamilyOrAdmin, isAdmin, member } from '../../utils/access.js';
import { istDayDiff, istMidnight, istParts, periodLabel, periodOf, shiftPeriod } from '../../utils/dates.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { formatPaise } from '../../utils/money.js';
import { PaginationQuery, pageResult, skipFor } from '../../utils/pagination.js';
import { DateInput, ObjectIdSchema, Paise, PaiseOrZero, PaymentMode, Period, Url } from '../../utils/schemas.js';
import { dueView, generateDues, isOverdue, recalcDue } from './dues.service.js';

const IdParams = z.object({ id: ObjectIdSchema });

// =========================== /maintenance/plan ===========================
export const maintenanceRouter = Router({ mergeParams: true });

maintenanceRouter.get('/plan', async (req, res) => {
  const society = await SocietyModel.findById(member(req).societyId, { maintenance: 1 }).lean();
  res.json({ plan: society?.maintenance ?? null });
});

const PlanBody = z
  .strictObject({
    amount: PaiseOrZero,
    dueDay: z.number().int().min(1).max(28),
    generateOnDay: z.number().int().min(1).max(28).default(1),
    reminderDaysBefore: z.array(z.number().int().min(1).max(15)).max(5).default([3, 1]),
    overdueReminderEveryDays: z.number().int().min(1).max(30).default(3),
    isActive: z.boolean(),
    startPeriod: Period,
  })
  .refine((p) => p.generateOnDay <= p.dueDay, { message: 'Dues must be created on or before the due day', path: ['generateOnDay'] });

maintenanceRouter.put('/plan', requirePermission('maintenance.setPlan'), validate({ body: PlanBody }), async (req, res) => {
  const { societyId } = member(req);
  const plan = req.valid!.body as z.infer<typeof PlanBody>;
  const before = await SocietyModel.findById(societyId, { maintenance: 1 }).lean();
  await SocietyModel.updateOne({ _id: societyId }, { $set: { maintenance: plan } });
  await audit({ societyId, actorId: req.userId!, action: 'maintenance.plan_set', entity: 'society', entityId: societyId, before: before?.maintenance, after: plan });
  res.json({ plan });
});

// =========================== /dues ===========================
export const duesRouter = Router({ mergeParams: true });

const DuesQuery = PaginationQuery.extend({
  period: Period.optional(),
  status: z.enum(['pending', 'partial', 'paid', 'waived', 'unpaid', 'overdue']).optional(),
  familyId: ObjectIdSchema.optional(),
});

/** Residents only ever get their own family's dues; admins can see everyone's. */
duesRouter.get('/', validate({ query: DuesQuery }), async (req, res) => {
  const q = req.valid!.query as z.infer<typeof DuesQuery>;
  const m = member(req);
  const filter: Record<string, unknown> = { societyId: m.societyId };
  if (isAdmin(req)) {
    if (q.familyId) filter.familyId = q.familyId;
  } else {
    if (!m.familyId) return res.json(pageResult([], 0, q));
    filter.familyId = m.familyId;
  }
  if (q.period) filter.period = q.period;
  if (q.status === 'unpaid' || q.status === 'overdue') filter.status = { $in: ['pending', 'partial'] };
  else if (q.status) filter.status = q.status;
  if (q.status === 'overdue') {
    const t = istParts();
    filter.dueDate = { $lt: istMidnight(t.year, t.month, t.day) }; // due day already over (IST)
  }

  const [items, total] = await Promise.all([
    DueModel.find(filter)
      .sort({ period: -1, dueDate: 1 })
      .skip(skipFor(q))
      .limit(q.limit)
      .populate('familyId', 'unitNumber head.name'),
    DueModel.countDocuments(filter),
  ]);
  const now = new Date();
  res.json(pageResult(items.map((d) => dueView(d, now)), total, q));
});

const GenerateBody = z.strictObject({ period: Period.optional() });

/** Manual / backfill generation. Idempotent: running it twice creates nothing new. */
duesRouter.post('/generate', requirePermission('payments.record'), validate({ body: GenerateBody }), async (req, res) => {
  const { societyId } = member(req);
  const period = (req.valid!.body as z.infer<typeof GenerateBody>).period ?? periodOf();
  if (period > shiftPeriod(periodOf(), 1)) throw badRequest('TOO_EARLY', 'You can only generate up to next month');
  const result = await generateDues(societyId, period);
  await audit({ societyId, actorId: req.userId!, action: 'dues.generated', entity: 'due', after: { period, ...result } });
  res.json({ period, ...result });
});

const SummaryQuery = z.object({ period: Period.optional() });

/** Expected vs collected for a month, plus the list of families still owing. */
duesRouter.get('/summary', requirePermission('dues.viewAll'), validate({ query: SummaryQuery }), async (req, res) => {
  const { societyId } = member(req);
  const period = (req.valid!.query as z.infer<typeof SummaryQuery>).period ?? periodOf();
  const dues = await DueModel.find({ societyId, period }).populate<{ familyId: { _id: unknown; unitNumber: string; head: { name: string; phone: string } } }>(
    'familyId',
    'unitNumber head.name head.phone',
  ).lean();

  // Unpaid balances from EARLIER months, per family ("Also owes October ₹4,000").
  const older = await DueModel.aggregate<{ _id: Types.ObjectId; balance: number; periods: string[] }>([
    { $match: { societyId, period: { $lt: period }, status: { $in: ['pending', 'partial'] } } },
    { $group: { _id: '$familyId', balance: { $sum: { $subtract: ['$amount', '$amountPaid'] } }, periods: { $push: '$period' } } },
  ]);
  const arrears = new Map(older.map((o) => [String(o._id), o]));

  const now = new Date();
  const counts = { pending: 0, partial: 0, paid: 0, waived: 0 } as Record<string, number>;
  let expected = 0;
  let collected = 0;
  const defaulters: unknown[] = [];
  for (const d of dues) {
    counts[d.status] += 1;
    if (d.status !== 'waived') expected += d.amount;
    collected += d.amountPaid;
    if (d.status === 'pending' || d.status === 'partial') {
      const prev = d.familyId ? arrears.get(String(d.familyId._id)) : undefined;
      defaulters.push({
        dueId: d._id,
        family: d.familyId ? { id: d.familyId._id, unitNumber: d.familyId.unitNumber, headName: d.familyId.head?.name, headPhone: d.familyId.head?.phone } : null,
        amount: d.amount,
        amountPaid: d.amountPaid,
        balance: d.amount - d.amountPaid,
        isOverdue: isOverdue(d, now),
        lastReminderAt: d.lastReminderAt ?? null,
        olderBalance: prev?.balance ?? 0,
        olderPeriods: (prev?.periods ?? []).sort(),
        totalOwed: d.amount - d.amountPaid + (prev?.balance ?? 0),
      });
    }
  }
  const pendingVerification = await PaymentModel.countDocuments({ societyId, status: 'pending_verification' });
  res.json({
    period,
    families: dues.length,
    expected,
    collected,
    pending: Math.max(0, expected - collected),
    counts,
    pendingVerification,
    defaulters: (defaulters as { family: { unitNumber: string } | null }[]).sort((a, b) =>
      (a.family?.unitNumber ?? '').localeCompare(b.family?.unitNumber ?? '', 'en', { numeric: true }),
    ),
  });
});

const RemindBody = z.strictObject({
  period: Period.optional(),
  dueIds: z.array(ObjectIdSchema).max(500).optional(), // omit = every unpaid family for the month
});

/**
 * "Remind all" (or selected dues) by hand. Skips families already reminded today (IST),
 * so pressing it twice doesn't double-send.
 */
duesRouter.post('/remind', requirePermission('payments.record'), validate({ body: RemindBody }), async (req, res) => {
  const { societyId } = member(req);
  const body = req.valid!.body as z.infer<typeof RemindBody>;
  const period = body.period ?? periodOf();
  const filter: Record<string, unknown> = { societyId, period, status: { $in: ['pending', 'partial'] } };
  if (body.dueIds) filter._id = { $in: body.dueIds };

  const now = new Date();
  let sent = 0;
  let skipped = 0;
  for (const due of await DueModel.find(filter)) {
    if (due.lastReminderAt && istDayDiff(due.lastReminderAt, now) === 0) {
      skipped += 1;
      continue;
    }
    const balance = due.amount - due.amountPaid;
    const late = isOverdue(due, now);
    await notify({
      userIds: await familyMemberUserIds(societyId, due.familyId),
      societyId,
      type: late ? 'due_overdue' : 'due_reminder',
      title: late ? 'Maintenance overdue' : 'Maintenance reminder',
      body: `A reminder from your committee: ${formatPaise(balance)} for ${periodLabel(period)} is ${late ? 'overdue' : 'due'}.`,
      data: { dueId: String(due._id) },
    });
    due.reminderCount += 1;
    due.lastReminderAt = now;
    await due.save();
    sent += 1;
  }
  await audit({ societyId, actorId: req.userId!, action: 'dues.reminded', entity: 'due', after: { period, sent } });
  res.json({ period, sent, skipped });
});

const WaiveBody = z.strictObject({ reason: z.string().trim().min(3).max(300) });

duesRouter.post('/:id/waive', requirePermission('dues.waive'), validate({ params: IdParams, body: WaiveBody }), async (req, res) => {
  const { societyId } = member(req);
  const due = await DueModel.findOne({ _id: req.valid!.params.id, societyId });
  if (!due) throw notFound('Due');
  if (due.status === 'paid') throw conflict('ALREADY_PAID', 'This due is already paid');
  const before = { status: due.status };
  due.set({ status: 'waived', waivedReason: req.valid!.body.reason, waivedBy: req.userId });
  await due.save();
  await audit({ societyId, actorId: req.userId!, action: 'due.waived', entity: 'due', entityId: due._id, before, after: { status: 'waived', reason: due.waivedReason } });
  res.json({ due: dueView(due) });
});

// =========================== /payments ===========================
export const paymentsRouter = Router({ mergeParams: true });

async function loadDueForSociety(societyId: Types.ObjectId, dueId: string) {
  const due = await DueModel.findOne({ _id: dueId, societyId });
  if (!due) throw notFound('Due');
  return due;
}

async function notifyFamilyPayment(payment: InstanceType<typeof PaymentModel>, period: string) {
  if (!payment.familyId) return;
  await notify({
    userIds: await familyMemberUserIds(payment.societyId, payment.familyId),
    societyId: payment.societyId,
    type: 'payment_recorded',
    title: 'Payment received',
    body: `${formatPaise(payment.amount)} received for ${periodLabel(period)}. Receipt #${payment.receiptNumber}.`,
    data: { paymentId: String(payment._id) },
  });
}

const PaymentListQuery = PaginationQuery.extend({
  status: z.enum(['confirmed', 'pending_verification', 'rejected', 'voided']).optional(),
  familyId: ObjectIdSchema.optional(),
  dueId: ObjectIdSchema.optional(),
  kind: z.enum(['maintenance', 'other_income']).optional(),
});

paymentsRouter.get('/', validate({ query: PaymentListQuery }), async (req, res) => {
  const q = req.valid!.query as z.infer<typeof PaymentListQuery>;
  const m = member(req);
  const filter: Record<string, unknown> = { societyId: m.societyId };
  if (isAdmin(req)) {
    if (q.familyId) filter.familyId = q.familyId;
  } else {
    if (!m.familyId) return res.json(pageResult([], 0, q));
    filter.familyId = m.familyId;
  }
  for (const k of ['status', 'dueId', 'kind'] as const) if (q[k]) filter[k] = q[k];

  const [items, total] = await Promise.all([
    PaymentModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skipFor(q))
      .limit(q.limit)
      .populate('familyId', 'unitNumber')
      .populate('dueId', 'period amount')
      .populate('recordedBy', 'name'),
    PaymentModel.countDocuments(filter),
  ]);
  res.json(pageResult(items, total, q));
});

const RecordBody = z.strictObject({
  dueId: ObjectIdSchema,
  amount: Paise,
  mode: z.enum(['cash', 'upi', 'bank_transfer', 'cheque', 'other']),
  reference: z.string().trim().max(100).optional(),
  paidOn: DateInput,
  note: z.string().trim().max(500).optional(),
});

/** Admin records money received → confirmed straight away. One payment covers one month. */
paymentsRouter.post('/', requirePermission('payments.record'), validate({ body: RecordBody }), async (req, res) => {
  const body = req.valid!.body as z.infer<typeof RecordBody>;
  const { societyId } = member(req);
  const due = await loadDueForSociety(societyId, body.dueId);
  if (due.status === 'waived') throw conflict('DUE_WAIVED', 'This due was waived');
  if (body.paidOn > new Date()) throw badRequest('FUTURE_DATE', 'Payment date cannot be in the future');

  const payment = await PaymentModel.create({
    ...body,
    societyId,
    familyId: due.familyId,
    kind: 'maintenance',
    status: 'confirmed',
    source: 'admin_entry',
    recordedBy: req.userId,
    verifiedBy: req.userId,
    verifiedAt: new Date(),
    receiptNumber: await nextSeq(`${societyId}:receipt`),
  });
  await recalcDue(due._id);
  await audit({ societyId, actorId: req.userId!, action: 'payment.recorded', entity: 'payment', entityId: payment._id, after: { dueId: due._id, amount: body.amount, mode: body.mode } });
  await notifyFamilyPayment(payment, due.period);
  res.status(201).json({ payment, due: dueView((await DueModel.findById(due._id))!) });
});

const ReportBody = z.strictObject({
  dueId: ObjectIdSchema,
  amount: Paise,
  mode: PaymentMode,
  reference: z.string().trim().max(100).optional(),
  paidOn: DateInput,
  screenshotUrl: Url.optional(),
  note: z.string().trim().max(500).optional(),
});

/** Resident says "I paid by UPI, here is the reference" → waits for an admin to verify. */
paymentsRouter.post('/report', requirePermission('payments.report'), validate({ body: ReportBody }), async (req, res) => {
  const body = req.valid!.body as z.infer<typeof ReportBody>;
  const m = member(req);
  const due = await loadDueForSociety(m.societyId, body.dueId);
  if (!m.familyId || String(due.familyId) !== String(m.familyId)) {
    throw badRequest('NOT_YOUR_DUE', 'You can only report payments for your own family');
  }
  if (due.status === 'paid' || due.status === 'waived') throw conflict('NOTHING_DUE', 'Nothing is due for this month');
  if (body.screenshotUrl && !isOurUpload(body.screenshotUrl)) throw badRequest('BAD_UPLOAD', 'Upload the screenshot through the app');

  const payment = await PaymentModel.create({
    ...body,
    societyId: m.societyId,
    familyId: due.familyId,
    kind: 'maintenance',
    status: 'pending_verification',
    source: 'resident_report',
    recordedBy: req.userId,
  });
  const [user, family] = await Promise.all([
    UserModel.findById(req.userId, { name: 1 }).lean(),
    FamilyModel.findById(due.familyId, { unitNumber: 1 }).lean(),
  ]);
  await notify({
    userIds: await adminUserIds(m.societyId),
    societyId: m.societyId,
    type: 'payment_reported',
    title: 'Payment to verify',
    body: `${user?.name} (${family?.unitNumber}) reports ${formatPaise(body.amount)} for ${periodLabel(due.period)} by ${body.mode.replace('_', ' ')}.`,
    data: { paymentId: String(payment._id) },
  });
  res.status(201).json({ payment });
});

const VerifyBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('confirm') }),
  z.strictObject({ action: z.literal('reject'), reason: z.string().trim().min(3).max(300) }),
]);

paymentsRouter.post('/:id/verify', requirePermission('payments.record'), validate({ params: IdParams, body: VerifyBody }), async (req, res) => {
  const body = req.valid!.body as z.infer<typeof VerifyBody>;
  const { societyId } = member(req);
  const payment = await PaymentModel.findOne({ _id: req.valid!.params.id, societyId });
  if (!payment) throw notFound('Payment');
  if (payment.status !== 'pending_verification') throw conflict('NOT_PENDING', 'This payment is not waiting for verification');
  const due = payment.dueId ? await DueModel.findById(payment.dueId) : null;

  if (body.action === 'confirm') {
    payment.set({ status: 'confirmed', verifiedBy: req.userId, verifiedAt: new Date(), receiptNumber: await nextSeq(`${societyId}:receipt`) });
    await payment.save();
    if (due) await recalcDue(due._id);
    await notifyFamilyPayment(payment, due?.period ?? periodOf(payment.paidOn));
  } else {
    payment.set({ status: 'rejected', verifiedBy: req.userId, verifiedAt: new Date(), rejectionReason: body.reason });
    await payment.save();
    await notify({
      userIds: [payment.recordedBy],
      societyId,
      type: 'payment_rejected',
      title: 'Payment not confirmed',
      body: `Your ${formatPaise(payment.amount)} payment report was not confirmed: ${body.reason}`,
      data: { paymentId: String(payment._id) },
    });
  }
  await audit({ societyId, actorId: req.userId!, action: `payment.${body.action === 'confirm' ? 'verified' : 'rejected'}`, entity: 'payment', entityId: payment._id, after: body });
  res.json({ payment });
});

const VoidBody = z.strictObject({ reason: z.string().trim().min(3).max(300) });

/** Fixes a wrongly recorded payment without deleting it; the due is recalculated. */
paymentsRouter.post('/:id/void', requirePermission('dues.waive'), validate({ params: IdParams, body: VoidBody }), async (req, res) => {
  const { societyId } = member(req);
  const payment = await PaymentModel.findOne({ _id: req.valid!.params.id, societyId });
  if (!payment) throw notFound('Payment');
  if (payment.status !== 'confirmed') throw conflict('NOT_CONFIRMED', 'Only confirmed payments can be voided');
  payment.set({ status: 'voided', voidReason: req.valid!.body.reason });
  await payment.save();
  if (payment.dueId) await recalcDue(payment.dueId);
  await audit({ societyId, actorId: req.userId!, action: 'payment.voided', entity: 'payment', entityId: payment._id, before: { status: 'confirmed' }, after: { status: 'voided', reason: payment.voidReason } });
  res.json({ payment });
});

/** Data for the in-app receipt screen. */
paymentsRouter.get('/:id/receipt', validate({ params: IdParams }), async (req, res) => {
  const { societyId } = member(req);
  const payment = await PaymentModel.findOne({ _id: req.valid!.params.id, societyId, status: 'confirmed' })
    .populate<{ recordedBy: { name: string } }>('recordedBy', 'name')
    .lean();
  if (!payment) throw notFound('Receipt');
  if (payment.familyId) assertOwnFamilyOrAdmin(req, payment.familyId);
  else if (!isAdmin(req)) throw notFound('Receipt');

  const [society, family, due] = await Promise.all([
    SocietyModel.findById(societyId, { name: 1, address: 1 }).lean(),
    payment.familyId ? FamilyModel.findById(payment.familyId, { unitNumber: 1, 'head.name': 1 }).lean() : null,
    payment.dueId ? DueModel.findById(payment.dueId, { period: 1 }).lean() : null,
  ]);
  res.json({
    receipt: {
      receiptNumber: payment.receiptNumber,
      society: { name: society?.name, address: society?.address },
      family: family ? { unitNumber: family.unitNumber, headName: family.head?.name } : null,
      period: due?.period ?? null,
      periodLabel: due ? periodLabel(due.period) : null,
      title: payment.title ?? (due ? `Maintenance for ${periodLabel(due.period)}` : 'Payment'),
      amount: payment.amount,
      amountFormatted: formatPaise(payment.amount),
      mode: payment.mode,
      reference: payment.reference,
      paidOn: payment.paidOn,
      recordedBy: payment.recordedBy?.name,
      issuedAt: payment.verifiedAt ?? payment.createdAt,
      paymentId: new Types.ObjectId(String(payment._id)),
    },
  });
});
