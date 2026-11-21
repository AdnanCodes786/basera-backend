import { cert, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { env, isTest } from '../config/env.js';
import { logger } from '../config/logger.js';

let app: App | null | undefined;

function firebase(): App | null {
  if (app !== undefined) return app;
  if (!env.FIREBASE_SERVICE_ACCOUNT || isTest) {
    app = null;
    return app;
  }
  const raw = env.FIREBASE_SERVICE_ACCOUNT.trim();
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  app = initializeApp({ credential: cert(JSON.parse(json)) }, 'basera');
  logger.info('Firebase push enabled');
  return app;
}

export function pushEnabled(): boolean {
  return firebase() !== null;
}

/**
 * Sends one push to many device tokens. Returns the tokens FCM says are dead
 * (app uninstalled / token rotated) so the caller can delete them.
 */
export async function sendPush(
  tokens: string[],
  message: { title: string; body: string; data?: Record<string, string> },
): Promise<string[]> {
  const fb = firebase();
  if (!fb || tokens.length === 0) return [];

  const dead: string[] = [];
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const res = await getMessaging(fb).sendEachForMulticast({
      tokens: batch,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: { priority: 'high' },
    });
    res.responses.forEach((r, idx) => {
      const code = r.error?.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        dead.push(batch[idx]);
      }
    });
  }
  return dead;
}
