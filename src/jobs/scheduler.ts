import cron from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  adminWeeklyDigestJob,
  complaintSlaJob,
  dailyCleanupJob,
  generateDuesJob,
  sendDueRemindersJob,
  statementReadyJob,
} from './jobs.js';

const JOBS: { name: string; schedule: string; run: () => Promise<unknown> }[] = [
  { name: 'generateDues', schedule: '15 0 * * *', run: () => generateDuesJob() }, // daily 00:15
  { name: 'sendDueReminders', schedule: '0 9 * * *', run: () => sendDueRemindersJob() }, // daily 09:00
  { name: 'complaintSlaCheck', schedule: '5 * * * *', run: () => complaintSlaJob() }, // hourly at :05
  { name: 'statementReady', schedule: '0 10 2 * *', run: () => statementReadyJob() }, // 2nd, 10:00
  { name: 'adminWeeklyDigest', schedule: '30 9 * * 1', run: () => adminWeeklyDigestJob() }, // Monday 09:30
  { name: 'dailyCleanup', schedule: '0 3 * * *', run: () => dailyCleanupJob() }, // daily 03:00
];

export const JOB_NAMES = JOBS.map((j) => j.name);

/** Runs a job by name and logs the result. Used by the scheduler and by `npm run job <name>`. */
export async function runJob(name: string) {
  const job = JOBS.find((j) => j.name === name);
  if (!job) throw new Error(`Unknown job "${name}". Known: ${JOB_NAMES.join(', ')}`);
  const started = Date.now();
  try {
    const result = await job.run();
    logger.info({ job: name, ms: Date.now() - started, result }, 'Job finished');
    return result;
  } catch (err) {
    logger.error({ err, job: name }, 'Job failed');
    throw err;
  }
}

/** Starts all jobs in IST. Only one server should run them: set ENABLE_JOBS=true on exactly one. */
export function startScheduler() {
  if (!env.ENABLE_JOBS) {
    logger.info('Scheduled jobs are off (ENABLE_JOBS=false)');
    return;
  }
  for (const job of JOBS) {
    cron.schedule(job.schedule, () => void runJob(job.name).catch(() => {}), {
      timezone: env.APP_TIMEZONE,
      name: job.name,
      noOverlap: true,
    });
  }
  logger.info({ jobs: JOB_NAMES, timezone: env.APP_TIMEZONE }, 'Scheduled jobs started');
}
