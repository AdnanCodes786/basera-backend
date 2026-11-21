import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { NoticeModel } from '../../models/notice.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { allMemberUserIds } from '../../services/recipients.js';
import { isOurUpload } from '../../services/storage.js';
import { member } from '../../utils/access.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { PaginationQuery, pageResult, skipFor } from '../../utils/pagination.js';
import { DateInput, ObjectIdSchema, QueryBool, Url } from '../../utils/schemas.js';

/** Mounted at /societies/:societyId/notices */
export const noticesRouter = Router({ mergeParams: true });
const IdParams = z.object({ id: ObjectIdSchema });

const ListQuery = PaginationQuery.extend({ archived: QueryBool.optional() });

/** Board: pinned first, then newest. Expired notices move to the archive tab (archived=true). */
noticesRouter.get('/', requirePermission('notices.read'), validate({ query: ListQuery }), async (req, res) => {
  const q = req.valid!.query as z.infer<typeof ListQuery>;
  const now = new Date();
  const filter: Record<string, unknown> = { societyId: member(req).societyId };
  if (q.archived) filter.expiresAt = { $ne: null, $lte: now };
  else filter.$or = [{ expiresAt: null }, { expiresAt: { $gt: now } }];

  const [items, total] = await Promise.all([
    NoticeModel.find(filter)
      .sort(q.archived ? { createdAt: -1 } : { isPinned: -1, createdAt: -1 })
      .skip(skipFor(q))
      .limit(q.limit)
      .populate('postedBy', 'name'),
    NoticeModel.countDocuments(filter),
  ]);
  res.json(pageResult(items, total, q));
});

const Attachments = z.array(Url).max(5).refine((urls) => urls.every(isOurUpload), 'Upload files through the app');

const NoticeBody = z.strictObject({
  title: z.string().trim().min(3).max(150),
  body: z.string().trim().min(1).max(5000),
  attachments: Attachments.optional(),
  isPinned: z.boolean().optional(),
  expiresAt: DateInput.nullable().optional(),
});

noticesRouter.post('/', requirePermission('notices.manage'), validate({ body: NoticeBody }), async (req, res) => {
  const body = req.valid!.body as z.infer<typeof NoticeBody>;
  const { societyId } = member(req);
  if (body.expiresAt && body.expiresAt <= new Date()) throw badRequest('PAST_EXPIRY', 'Expiry must be in the future');
  const notice = await NoticeModel.create({ ...body, societyId, postedBy: req.userId });
  await notify({
    userIds: await allMemberUserIds(societyId),
    societyId,
    type: 'notice_posted',
    title: `📢 ${notice.title}`,
    body: notice.body.slice(0, 140),
    data: { noticeId: String(notice._id) },
    excludeUserId: req.userId,
  });
  res.status(201).json({ notice });
});

noticesRouter.get('/:id', requirePermission('notices.read'), validate({ params: IdParams }), async (req, res) => {
  const notice = await NoticeModel.findOne({ _id: req.valid!.params.id, societyId: member(req).societyId }).populate('postedBy', 'name');
  if (!notice) throw notFound('Notice');
  res.json({ notice });
});

noticesRouter.patch(
  '/:id',
  requirePermission('notices.manage'),
  validate({ params: IdParams, body: NoticeBody.partial() }),
  async (req, res) => {
    const notice = await NoticeModel.findOne({ _id: req.valid!.params.id, societyId: member(req).societyId });
    if (!notice) throw notFound('Notice');
    notice.set(req.valid!.body);
    await notice.save();
    res.json({ notice });
  },
);

noticesRouter.delete('/:id', requirePermission('notices.manage'), validate({ params: IdParams }), async (req, res) => {
  const { societyId } = member(req);
  const notice = await NoticeModel.findOneAndDelete({ _id: req.valid!.params.id, societyId });
  if (!notice) throw notFound('Notice');
  await audit({ societyId, actorId: req.userId!, action: 'notice.deleted', entity: 'notice', entityId: notice._id, before: { title: notice.title } });
  res.status(204).end();
});
