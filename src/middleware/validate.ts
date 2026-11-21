import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

type Schemas = { body?: ZodType; query?: ZodType; params?: ZodType };

/**
 * Validates and parses body/query/params with Zod. Parsed values land on `req.valid`
 * (Express 5 makes `req.query` read-only). Body schemas should be strict so unknown
 * fields are rejected. A ZodError is turned into a 400 by the error handler.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    req.valid = {
      body: schemas.body ? schemas.body.parse(req.body ?? {}) : undefined,
      query: schemas.query ? schemas.query.parse(req.query) : undefined,
      params: schemas.params ? schemas.params.parse(req.params) : undefined,
    };
    next();
  };
}
