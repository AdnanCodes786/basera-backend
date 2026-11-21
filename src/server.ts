import mongoose from 'mongoose';
import { createApp } from './app.js';
import { connectDb, disconnectDb } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { startScheduler } from './jobs/scheduler.js';

async function main() {
  await connectDb(env.MONGODB_URI);
  // Creates any missing indexes (unique rules, TTL clean-up) on startup.
  // An index left over from an older version must not stop the server: warn and carry on.
  for (const model of Object.values(mongoose.models)) {
    try {
      await model.createIndexes();
    } catch (err) {
      logger.warn(
        { model: model.modelName, err: (err as Error).message },
        'Index conflict with an older version of the database. Run `npm run db:migrate` to fix it.',
      );
    }
  }

  const server = createApp().listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}`);
  });
  startScheduler();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
