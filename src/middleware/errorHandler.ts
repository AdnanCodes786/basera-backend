import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';

function sendError(res: Response, status: number, code: string, message: string, details?: unknown) {
  res.locals.errorCode = code; // picked up by the apiLogs middleware
  res.status(status).json({ error: { code, message, details } });
}

export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(res, 404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`);
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) return sendError(res, err.status, err.code, err.message, err.details);

  if (err instanceof ZodError) {
    return sendError(
      res,
      400,
      'VALIDATION_ERROR',
      'Some fields are missing or invalid',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }

  // Malformed JSON body
  if (err?.type === 'entity.parse.failed') {
    return sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
  }

  if (err instanceof mongoose.Error.CastError) {
    return sendError(res, 400, 'INVALID_ID', `Invalid ${err.path}`);
  }

  if (err instanceof mongoose.Error.ValidationError) {
    return sendError(
      res,
      400,
      'VALIDATION_ERROR',
      'Some fields are missing or invalid',
      Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
    );
  }

  if (err?.code === 11000) {
    return sendError(res, 409, 'DUPLICATE', 'This record already exists', err.keyValue);
  }

  req.log?.error({ err }, 'Unhandled error');
  sendError(res, 500, 'INTERNAL', 'Something went wrong');
};
