import mongoose from 'mongoose';
import { logger } from './logger.js';

// Every model returns `id` instead of `_id` and drops `__v` in JSON responses.
mongoose.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret._id;
    return ret;
  },
});
mongoose.set('strictQuery', true);

export async function connectDb(uri: string): Promise<void> {
  await mongoose.connect(uri);
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
