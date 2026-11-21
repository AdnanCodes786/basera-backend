import type { Types } from 'mongoose';
import type { Role } from '../config/permissions.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `authenticate`. */
      userId?: string;
      /** Set by `societyGuard`. The only trusted source of societyId inside society routes. */
      membership?: {
        id: Types.ObjectId;
        societyId: Types.ObjectId;
        familyId: Types.ObjectId | null;
        role: Role;
      };
      /** Parsed output of `validate()`. */
      valid?: { body?: any; query?: any; params?: any };
    }
  }
}

export {};
