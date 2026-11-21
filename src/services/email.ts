import nodemailer from 'nodemailer';
import { env, isProd, isTest } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/errors.js';

type Mail = { to: string; subject: string; text: string; html?: string };

/** Emails "sent" during tests, so tests can read the login code. */
export const testOutbox: Mail[] = [];

let smtp: ReturnType<typeof nodemailer.createTransport> | undefined;

/**
 * Sends one email. Order: SMTP (Gmail) if SMTP_USER/SMTP_PASS are set, else Resend if RESEND_API_KEY is set.
 * Resend: https://resend.com (needs a verified domain to email anyone).
 * With neither:
 *  - development: the email is printed in the server terminal (so you can copy the code),
 *  - production: refuses, because nobody would get their code.
 */
export async function sendEmail(mail: Mail): Promise<void> {
  if (isTest) {
    testOutbox.push(mail);
    return;
  }
  if (env.SMTP_USER && env.SMTP_PASS) {
    smtp ??= nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
    try {
      await smtp.sendMail({ from: `Basera <${env.SMTP_USER}>`, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    } catch (err) {
      logger.error({ reason: err instanceof Error ? err.message : 'unknown' }, 'SMTP send failed');
      throw new AppError(502, 'EMAIL_FAILED', 'Could not send the email. Try again in a minute.');
    }
    return;
  }
  if (!env.RESEND_API_KEY) {
    if (isProd) throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'Email is not set up on the server yet');
    logger.warn({ to: mail.to, subject: mail.subject }, `\n--- EMAIL (dev, not sent) ---\n${mail.text}\n-----------------------------`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
  });
  if (!res.ok) {
    logger.error({ status: res.status, body: await res.text().catch(() => '') }, 'Email send failed');
    throw new AppError(502, 'EMAIL_FAILED', 'Could not send the email. Try again in a minute.');
  }
}

export function loginCodeEmail(code: string, purpose: 'login' | 'delete_account'): Mail & { to: '' } {
  const what = purpose === 'login' ? 'sign in to Basera' : 'confirm deleting your Basera account';
  return {
    to: '',
    subject: `${code} is your Basera code`,
    text: `Your code to ${what} is ${code}.\n\nIt works for 10 minutes. If you didn't ask for it, ignore this email.`,
    html: `<p>Your code to ${what} is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It works for 10 minutes. If you didn't ask for it, ignore this email.</p>`,
  };
}
