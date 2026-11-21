import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { requirePermission } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { COMPLAINT_CATEGORIES, COMPLAINT_STATUSES, ComplaintModel } from '../../models/complaint.js';
import { nextSeq } from '../../models/counter.js';
import { SocietyModel } from '../../models/society.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { adminUserIds } from '../../services/recipients.js';
import { isOurUpload, signUpload } from '../../services/storage.js';
import { isAdmin, member } from '../../utils/access.js';
import { addDays, addHours } from '../../utils/dates.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors.js';
import { PaginationQuery, pageResult, skipFor } from '../../utils/pagination.js';
import { ObjectIdSchema, QueryBool, Url } from '../../utils/schemas.js';

export const ACTIVE_STATUSES = ['open', 'acknowledged', 'in_progress'] as const;
const REOPEN_WINDOW_DAYS = 7;

/** Mounted at /societies/:societyId/complaints */
export const complaintsRouter = Router({ mergeParams: true });
const IdParams = z.object({ id: ObjectIdSchema });

async function slaHours(societyId: Types.ObjectId): Promise<number> {
  const s = await SocietyModel.findById(societyId, { 'settings.complaintSlaHours': 1 }).lean();
  return s?.settings?.complaintSlaHours ?? 48;
}

function complaintView(c: { toJSON(): unknown; status: string; nextUpdateDueAt?: Date | null }, now = new Date()) {
  const json = c.toJSON() as Record<string, unknown>;
  return {
    ...json,
    isOverdue: (ACTIVE_STATUSES as readonly string[]).includes(c.status) && !!c.nextUpdateDueAt && c.nextUpdateDueAt < now,
  };
}

async function loadComplaint(societyId: Types.ObjectId, id: string) {
  const c = await ComplaintModel.findOne({ _id: id, societyId });
  if (!c) throw notFound('Complaint');
  return c;
}

const ListQuery = PaginationQuery.extend({
  status: z.enum([...COMPLAINT_STATUSES, 'active']).optional(),
  category: z.enum(COMPLAINT_CATEGORIES).optional(),
  overdue: QueryBool.optional(),
  mine: QueryBool.optional(),
});

/** The complaint board is visible to every member. */
complaintsRouter.get('/', validate({ query: ListQuery }), async (req, res) => {
  const q = req.valid!.query as z.infer<typeof ListQuery>;
  const now = new Date();
  const filter: Record<string, unknown> = { societyId: member(req).societyId };
  if (q.status === 'active') filter.status = { $in: ACTIVE_STATUSES };
  else if (q.status) filter.status = q.status;
  if (q.category) filter.category = q.category;
  if (q.mine) filter.raisedBy = req.userId;
  if (q.overdue) Object.assign(filter, { status: { $in: ACTIVE_STATUSES }, nextUpdateDueAt: { $lt: now } });

  const [items, total] = await Promise.all([
    ComplaintModel.find(filter, { comments: 0, history: 0 })
      .sort({ createdAt: -1 })
      .skip(skipFor(q))
      .limit(q.limit)
      .populate('raisedBy', 'name')
      .populate('familyId', 'unitNumber'),
    ComplaintModel.countDocuments(filter),
  ]);
  res.json(pageResult(items.map((c) => complaintView(c, now)), total, q));
});

const Attachments = z.array(Url).max(5).refine((urls) => urls.every(isOurUpload), 'Upload photos through the app');

const CreateBody = z.strictObject({
  title: z.string().trim().min(3).max(150),
  description: z.string().trim().max(4000).optional(),
  category: z.enum(COMPLAINT_CATEGORIES).default('other'),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  attachments: Attachments.optional(),
});

complaintsRouter.post('/', requirePermission('complaints.raise'), validate({ body: CreateBody }), async (req, res) => {
  const body = req.valid!.body as z.infer<typeof CreateBody>;
  const m = member(req);
  const now = new Date();
  const complaint = await ComplaintModel.create({
    ...body,
    societyId: m.societyId,
    number: await nextSeq(`${m.societyId}:complaint`),
    raisedBy: req.userId,
    familyId: m.familyId,
    status: 'open',
    history: [{ status: 'open', by: req.userId, at: now }],
    nextUpdateDueAt: addHours(now, await slaHours(m.societyId)),
  });
  await notify({
    userIds: await adminUserIds(m.societyId),
    societyId: m.societyId,
    type: 'complaint_new',
    title: `New complaint #${complaint.number}`,
    body: complaint.title,
    data: { complaintId: String(complaint._id) },
    excludeUserId: req.userId,
  });
  res.status(201).json({ complaint: complaintView(complaint, now) });
});

complaintsRouter.get('/:id', validate({ params: IdParams }), async (req, res) => {
  const c = await ComplaintModel.findOne({ _id: req.valid!.params.id, societyId: member(req).societyId })
    .populate('raisedBy', 'name')
    .populate('familyId', 'unitNumber')
    .populate('history.by', 'name')
    .populate('comments.by', 'name');
  if (!c) throw notFound('Complaint');
  res.json({ complaint: complaintView(c) });
});

const StatusBody = z
  .strictObject({
    status: z.enum(['acknowledged', 'in_progress', 'resolved', 'closed', 'rejected']),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((b) => b.status !== 'rejected' || (b.note && b.note.length >= 3), {
    message: 'Give a reason when rejecting',
    path: ['note'],
  });

/**
 * Admin status update. This is the ONLY thing that resets the 48-hour clock
 * (comments don't). Resolved / closed / rejected stop the clock.
 */
complaintsRouter.post(
  '/:id/status',
  requirePermission('complaints.updateStatus'),
  validate({ params: IdParams, body: StatusBody }),
  async (req, res) => {
    const { status, note } = req.valid!.body as z.infer<typeof StatusBody>;
    const { societyId } = member(req);
    const c = await loadComplaint(societyId, req.valid!.params.id);
    if (c.status === 'closed' || c.status === 'rejected') {
      throw conflict('COMPLAINT_FINISHED', 'This complaint is already closed');
    }
    const now = new Date();
    const stopsClock = status === 'resolved' || status === 'closed' || status === 'rejected';
    const before = c.status;
    c.status = status;
    c.history.push({ status, note, by: req.userId, at: now });
    c.lastAdminUpdateAt = now;
    c.nextUpdateDueAt = stopsClock ? null : addHours(now, await slaHours(societyId));
    c.lastBreachNotifiedAt = null;
    if (status === 'resolved') c.resolvedAt = now;
    await c.save();

    await audit({ societyId, actorId: req.userId!, action: 'complaint.status_changed', entity: 'complaint', entityId: c._id, before: { status: before }, after: { status, note } });
    await notify({
      userIds: [c.raisedBy],
      societyId,
      type: 'complaint_update',
      title: `Complaint #${c.number}: ${status.replace('_', ' ')}`,
      body: note || c.title,
      data: { complaintId: String(c._id) },
      excludeUserId: req.userId,
    });
    res.json({ complaint: complaintView(c, now) });
  },
);

const CommentBody = z.strictObject({ text: z.string().trim().min(1).max(2000) });

complaintsRouter.post(
  '/:id/comments',
  requirePermission('complaints.raise'),
  validate({ params: IdParams, body: CommentBody }),
  async (req, res) => {
    const { societyId } = member(req);
    const c = await loadComplaint(societyId, req.valid!.params.id);
    if (c.status === 'closed' || c.status === 'rejected') throw conflict('COMPLAINT_FINISHED', 'This complaint is closed');
    c.comments.push({ by: req.userId, text: req.valid!.body.text, at: new Date() });
    c.commentCount = c.comments.length;
    await c.save();
    const recipients = String(c.raisedBy) === req.userId ? await adminUserIds(societyId) : [c.raisedBy];
    await notify({
      userIds: recipients,
      societyId,
      type: 'complaint_comment',
      title: `New comment on #${c.number}`,
      body: req.valid!.body.text.slice(0, 140),
      data: { complaintId: String(c._id) },
      excludeUserId: req.userId,
    });
    res.status(201).json({ comment: c.comments[c.comments.length - 1] });
  },
);

function assertRaiser(req: Parameters<typeof member>[0], c: InstanceType<typeof ComplaintModel>) {
  if (String(c.raisedBy) !== req.userId) throw forbidden('NOT_RAISER', 'Only the person who raised this complaint can do this');
}

/** The raiser confirms the fix. */
complaintsRouter.post('/:id/close', validate({ params: IdParams }), async (req, res) => {
  const { societyId } = member(req);
  const c = await loadComplaint(societyId, req.valid!.params.id);
  assertRaiser(req, c);
  if (c.status !== 'resolved') throw badRequest('NOT_RESOLVED', 'Only a resolved complaint can be closed');
  c.status = 'closed';
  c.nextUpdateDueAt = null;
  c.history.push({ status: 'closed', note: 'Closed by resident', by: req.userId, at: new Date() });
  await c.save();
  res.json({ complaint: complaintView(c) });
});

/** The raiser says it isn't fixed (within 7 days of resolution): back to open with a fresh 48h clock. */
complaintsRouter.post('/:id/reopen', validate({ params: IdParams, body: z.strictObject({ note: z.string().trim().max(1000).optional() }) }), async (req, res) => {
  const { societyId } = member(req);
  const c = await loadComplaint(societyId, req.valid!.params.id);
  assertRaiser(req, c);
  if (c.status !== 'resolved' && c.status !== 'closed') throw badRequest('NOT_RESOLVED', 'Only a resolved complaint can be reopened');
  if (!c.resolvedAt || addDays(c.resolvedAt, REOPEN_WINDOW_DAYS) < new Date()) {
    throw badRequest('REOPEN_WINDOW_PASSED', `Complaints can be reopened within ${REOPEN_WINDOW_DAYS} days. Raise a new one instead.`);
  }
  const now = new Date();
  c.status = 'open';
  c.resolvedAt = undefined;
  c.nextUpdateDueAt = addHours(now, await slaHours(societyId));
  c.lastBreachNotifiedAt = null;
  c.history.push({ status: 'open', note: req.valid!.body.note ?? 'Reopened by resident', by: req.userId, at: now });
  await c.save();
  await notify({
    userIds: await adminUserIds(societyId),
    societyId,
    type: 'complaint_update',
    title: `Complaint #${c.number} reopened`,
    body: c.title,
    data: { complaintId: String(c._id) },
  });
  res.json({ complaint: complaintView(c, now) });
});

// =========================== /uploads/sign ===========================
export const uploadsRouter = Router({ mergeParams: true });

const SignBody = z.strictObject({ purpose: z.enum(['complaint', 'payment', 'expense', 'notice']) });

/** Signed parameters so the app can upload a photo straight to Cloudinary. */
uploadsRouter.post('/sign', validate({ body: SignBody }), async (req, res) => {
  const { purpose } = req.valid!.body as z.infer<typeof SignBody>;
  if ((purpose === 'expense' || purpose === 'notice') && !isAdmin(req)) throw forbidden('WRONG_ROLE', 'Your role cannot do this');
  res.json(signUpload(String(member(req).societyId), purpose));
});
