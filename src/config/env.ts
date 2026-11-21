import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default('info'),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Resend (https://resend.com) for sign-in code emails. Empty in development = code printed in the terminal.
  RESEND_API_KEY: z.string().default(''),
  // Gmail (or any SMTP) sender: used first when SMTP_USER and SMTP_PASS are set. Gmail needs an App Password.
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  EMAIL_FROM: z.string().default('Basera <onboarding@resend.dev>'),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  ENABLE_JOBS: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Base of the invite link the app shares on WhatsApp/SMS: <INVITE_LINK_BASE>/<token>
  INVITE_LINK_BASE: z.string().default('https://basera.app/i'),
  INVITE_TTL_DAYS: z.coerce.number().int().positive().default(14),
  // Cloudinary (photos, receipts, documents). Leave empty until you have an account.
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  // Firebase service account JSON (raw JSON or base64 of it). Empty = in-app inbox only, no push.
  FIREBASE_SERVICE_ACCOUNT: z.string().default(''),
  // Request logs stored in the apiLogs collection, auto-deleted after N days.
  ENABLE_API_LOGS: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  API_LOG_TTL_DAYS: z.coerce.number().int().positive().default(14),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
