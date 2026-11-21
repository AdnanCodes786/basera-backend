/** Run one job by hand: `npm run job -- sendDueReminders` */
import { connectDb, disconnectDb } from '../config/db.js';
import { env } from '../config/env.js';
import { JOB_NAMES, runJob } from '../jobs/scheduler.js';
import '../models/index.js';

const name = process.argv[2];
if (!name) {
  console.log(`Usage: npm run job -- <name>\nJobs: ${JOB_NAMES.join(', ')}`);
  process.exit(1);
}

await connectDb(env.MONGODB_URI);
try {
  console.log(JSON.stringify(await runJob(name), null, 2));
} finally {
  await disconnectDb();
}
