import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { AuditLogModel } from '../../models/auditLog.js';
import { nextSeq } from '../../models/counter.js';
import { EXPENSE_CATEGORIES, ExpenseModel } from '../../models/expense.js';
import { PaymentModel } from '../../models/payment.js';
import { SocietyModel } from '../../models/society.js';
import { audit, diff } from '../../services/audit.js';
import { isOurUpload } from '../../services/storage.js';
import { isAdmin, member } from '../../utils/access.js';
import { periodOf, periodRange, shiftPeriod } from '../../utils/dates.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { PaginationQuery, pageResult, skipFor } from '../../utils/pagination.js';
import { DateInput, ObjectIdSchema, Paise, PaymentMode, Period, QueryBool, Url } from '../../utils/schemas.js';
import { computeStatement } from './statement.service.js';

/** Mounted at /societies/:societyId (paths: /expenses, /income, /statement, /finance) */
export const financeRouter = Router({ mergeParams: true });

const IdParams = z.object({ id: ObjectIdSchema });
const Receipts = z.array(Url).max(10).refine((urls) => urls.every(isOurUpload), 'Upload receipts through the app');

// ----------------------------- Expenses -----------------------------

const ExpenseQuery = PaginationQuery.extend({
  month: Period.optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  includeVoided: QueryBool.optional(),
});

/** Every member can see expenses and their receipts: that transparency is the point of the app. */
financeRouter.get('/expenses', validate({ query: ExpenseQuery }), async (req, res) => {
  const q = req.valid!.query as z.infer<typeof ExpenseQuery>;
  const filter: Record<string, unknown> = { societyId: member(req).societyId };
  if (!(isAdmin(req) && q.includeVoided)) filter.status = 'recorded';
  if (q.category) filter.category = q.category;
  if (q.month) {
    const { start, end } = periodRange(q.month);
    filter.spentOn = { $gte: start, $lt: end };
  }
  const [items, total] = await Promise.all([
    ExpenseModel.find(filter).sort({ spentOn: -1, createdAt: -1 }).skip(skipFor(q)).limit(q.limit).populate('recordedBy', 'name'),
    ExpenseModel.countDocuments(filter),
  ]);
  res.json(
    pageResult(
      items.map((e) => ({ ...e.toJSON(), hasReceipt: e.receipts.length > 0 })),
      total,
      q,
    ),
  );
});

const ExpenseBody = z.strictObject({
  title: z.string().trim().min(2).max(150),
  category: z.enum(EXPENSE_CATEGORIES),
  amount: Paise,
  spentOn: DateInput,
  paidTo: z.string().trim().max(150).optional(),
  mode: PaymentMode.optional(),
  reference: z.string().trim().max(100).optional(),
  receipts: Receipts.optional(),
});

financeRouter.post('/expenses', requirePermission('expenses.manage'), validate({ body: ExpenseBody }), async (req, res) => {
  const body = req.valid!.body as z.infer<typeof ExpenseBody>;
  const { societyId } = member(req);
  if (body.spentOn > new Date()) throw badRequest('FUTURE_DATE', 'Expense date cannot be in the future');
  const expense = await ExpenseModel.create({ ...body, societyId, recordedBy: req.userId });
  await audit({ societyId, actorId: req.userId!, action: 'expense.recorded', entity: 'expense', entityId: expense._id, after: body });
  res.status(201).json({ expense });
});

financeRouter.patch(
  '/expenses/:id',
  requirePermission('expenses.manage'),
  validate({ params: IdParams, body: ExpenseBody.partial() }),
  async (req, res) => {
    const { societyId } = member(req);
    const expense = await ExpenseModel.findOne({ _id: req.valid!.params.id, societyId });
    if (!expense) throw notFound('Expense');
    if (expense.status === 'voided') throw conflict('VOIDED', 'A voided expense cannot be edited');
    const before = expense.toObject() as Record<string, unknown>;
    expense.set(req.valid!.body);
    await expense.save();
    await audit({ societyId, actorId: req.userId!, action: 'expense.updated', entity: 'expense', entityId: expense._id, ...diff(before, expense.toObject() as Record<string, unknown>) });
    res.json({ expense });
  },
);

const VoidBody = z.strictObject({ reason: z.string().trim().min(3).max(300) });

financeRouter.post(
  '/expenses/:id/void',
  requirePermission('expenses.manage'),
  validate({ params: IdParams, body: VoidBody }),
  async (req, res) => {
    const { societyId } = member(req);
    const expense = await ExpenseModel.findOne({ _id: req.valid!.params.id, societyId });
    if (!expense) throw notFound('Expense');
    if (expense.status === 'voided') throw conflict('VOIDED', 'Already voided');
    expense.set({ status: 'voided', voidReason: req.valid!.body.reason, voidedBy: req.userId });
    await expense.save();
    await audit({ societyId, actorId: req.userId!, action: 'expense.voided', entity: 'expense', entityId: expense._id, after: { reason: expense.voidReason } });
    res.json({ expense });
  },
);

// ----------------------------- Other income -----------------------------

const IncomeBody = z.strictObject({
  title: z.string().trim().min(2).max(150),
  amount: Paise,
  mode: PaymentMode,
  reference: z.string().trim().max(100).optional(),
  paidOn: DateInput,
  familyId: ObjectIdSchema.optional(),
  note: z.string().trim().max(500).optional(),
});

/** Hall rent, donations, interest… a confirmed payment with no due, so the statement stays one formula. */
financeRouter.post('/income', requirePermission('expenses.manage'), validate({ body: IncomeBody }), async (req, res) => {
  const body = req.valid!.body as z.infer<typeof IncomeBody>;
  const { societyId } = member(req);
  if (body.paidOn > new Date()) throw badRequest('FUTURE_DATE', 'Date cannot be in the future');
  const payment = await PaymentModel.create({
    ...body,
    societyId,
    familyId: body.familyId ?? null,
    dueId: null,
    kind: 'other_income',
    status: 'confirmed',
    source: 'admin_entry',
    recordedBy: req.userId,
    verifiedBy: req.userId,
    verifiedAt: new Date(),
    receiptNumber: await nextSeq(`${societyId}:receipt`),
  });
  await audit({ societyId, actorId: req.userId!, action: 'income.recorded', entity: 'payment', entityId: payment._id, after: body });
  res.status(201).json({ payment });
});

// ----------------------------- Opening balance -----------------------------

const OpeningBody = z.strictObject({
  amount: z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00), // paise; can be negative if the society owes money
  date: DateInput,
});

financeRouter.put(
  '/finance/opening-balance',
  requirePermission('finance.openingBalance'),
  validate({ body: OpeningBody }),
  async (req, res) => {
    const { societyId } = member(req);
    const body = req.valid!.body as z.infer<typeof OpeningBody>;
    const before = await SocietyModel.findById(societyId, { finance: 1 }).lean();
    await SocietyModel.updateOne(
      { _id: societyId },
      { $set: { 'finance.openingBalance': body.amount, 'finance.openingBalanceDate': body.date } },
    );
    await audit({ societyId, actorId: req.userId!, action: 'finance.opening_balance_set', entity: 'society', entityId: societyId, before: before?.finance, after: body });
    res.json({ finance: { openingBalance: body.amount, openingBalanceDate: body.date } });
  },
);

// ----------------------------- Statement -----------------------------

const StatementQuery = z.object({ month: Period.optional() });

financeRouter.get('/statement', validate({ query: StatementQuery }), async (req, res) => {
  const month = (req.valid!.query as z.infer<typeof StatementQuery>).month ?? periodOf();
  res.json({ statement: await computeStatement(member(req).societyId, month) });
});

const SummaryQuery = z.object({ from: Period.optional(), to: Period.optional() });

/** Month-by-month totals for a chart (max 24 months). Months before the opening balance are skipped. */
financeRouter.get('/statement/summary', validate({ query: SummaryQuery }), async (req, res) => {
  const q = req.valid!.query as z.infer<typeof SummaryQuery>;
  const to = q.to ?? periodOf();
  const from = q.from ?? shiftPeriod(to, -5);
  if (from > to) throw badRequest('BAD_RANGE', '`from` must be before `to`');

  const months: unknown[] = [];
  for (let p = from, i = 0; p <= to && i < 24; p = shiftPeriod(p, 1), i++) {
    try {
      const s = await computeStatement(member(req).societyId, p);
      months.push({ period: s.period, periodLabel: s.periodLabel, income: s.income.total, expenses: s.expenses.total, closing: s.closing });
    } catch (err) {
      if ((err as { code?: string }).code !== 'BEFORE_OPENING') throw err;
    }
  }
  res.json({ months });
});

// ----------------------------- Audit log (admins) -----------------------------
export const auditRouter = Router({ mergeParams: true });

const AuditQuery = PaginationQuery.extend({
  entity: z.string().max(30).optional(),
  entityId: ObjectIdSchema.optional(),
  action: z.string().max(60).optional(),
});

auditRouter.get('/', requirePermission('members.view'), validate({ query: AuditQuery }), async (req, res) => {
  const q = req.valid!.query as z.infer<typeof AuditQuery>;
  const filter: Record<string, unknown> = { societyId: member(req).societyId };
  for (const k of ['entity', 'entityId', 'action'] as const) if (q[k]) filter[k] = q[k];
  const [items, total] = await Promise.all([
    AuditLogModel.find(filter).sort({ createdAt: -1 }).skip(skipFor(q)).limit(q.limit).populate('actorId', 'name'),
    AuditLogModel.countDocuments(filter),
  ]);
  res.json(pageResult(items, total, q));
});
