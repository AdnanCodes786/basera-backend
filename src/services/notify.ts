import { Types } from 'mongoose';
import { logger } from '../config/logger.js';
import { NotificationModel, type NotificationType } from '../models/notification.js';
import { UserModel } from '../models/user.js';
import { sendPush } from './push.js';

type Id = Types.ObjectId | string;

/**
 * The one way features send notifications:
 * 1. saves an inbox row per user, 2. pushes to their phones via FCM, 3. drops dead device tokens.
 * Later, WhatsApp/SMS channels plug in here without touching feature code.
 * Never throws: a notification failure must not fail the action that caused it.
 */
export async function notify(input: {
  userIds: Id[];
  societyId?: Id | null;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string>;
  excludeUserId?: Id;
}): Promise<void> {
  try {
    const exclude = input.excludeUserId ? String(input.excludeUserId) : null;
    const ids = [...new Set(input.userIds.map(String))].filter((id) => id !== exclude);
    if (ids.length === 0) return;

    await NotificationModel.insertMany(
      ids.map((userId) => ({
        userId,
        societyId: input.societyId ?? null,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data ?? {},
      })),
    );

    const users = await UserModel.find({ _id: { $in: ids }, isActive: true }).select('+deviceTokens').lean();
    const tokens = users.flatMap((u) => u.deviceTokens ?? []);
    const data = { type: input.type, ...(input.societyId ? { societyId: String(input.societyId) } : {}), ...input.data };
    const dead = await sendPush(tokens, { title: input.title, body: input.body, data });
    if (dead.length) {
      await UserModel.updateMany({ _id: { $in: ids } }, { $pull: { deviceTokens: { $in: dead } } });
    }
  } catch (err) {
    logger.error({ err, type: input.type }, 'Notification failed');
  }
}
