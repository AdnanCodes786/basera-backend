import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { NotificationModel } from '../../models/notification.js';
import { notFound } from '../../utils/errors.js';
import { PaginationQuery, pageResult, skipFor } from '../../utils/pagination.js';
import { ObjectIdSchema, QueryBool } from '../../utils/schemas.js';

/** Mounted at /api/v1/notifications: the in-app inbox across all of the user's societies. */
export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

const ListQuery = PaginationQuery.extend({
  unread: QueryBool.optional(),
  societyId: ObjectIdSchema.optional(),
});

notificationsRouter.get('/', validate({ query: ListQuery }), async (req, res) => {
  const q = req.valid!.query as z.infer<typeof ListQuery>;
  const filter: Record<string, unknown> = { userId: req.userId };
  if (q.unread) filter.readAt = null;
  if (q.societyId) filter.societyId = q.societyId;
  const [items, total, unreadCount] = await Promise.all([
    NotificationModel.find(filter).sort({ createdAt: -1 }).skip(skipFor(q)).limit(q.limit),
    NotificationModel.countDocuments(filter),
    NotificationModel.countDocuments({ userId: req.userId, readAt: null }),
  ]);
  res.json({ ...pageResult(items, total, q), unreadCount });
});

notificationsRouter.post('/read-all', async (req, res) => {
  const r = await NotificationModel.updateMany({ userId: req.userId, readAt: null }, { $set: { readAt: new Date() } });
  res.json({ updated: r.modifiedCount });
});

notificationsRouter.post('/:id/read', validate({ params: z.object({ id: ObjectIdSchema }) }), async (req, res) => {
  const n = await NotificationModel.findOneAndUpdate(
    { _id: req.valid!.params.id, userId: req.userId },
    { $set: { readAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!n) throw notFound('Notification');
  res.json({ notification: n });
});
