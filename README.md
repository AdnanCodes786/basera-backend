# Basera backend

API for the society-management app: Node.js 22+, Express 5, MongoDB (Mongoose), TypeScript.

## Run it

```bash
cp .env.example .env      # set MONGODB_URI and JWT_ACCESS_SECRET (rest is optional)
npm install
npm run dev               # http://localhost:4000/health
npm test                  # in-memory MongoDB, no setup needed
npm run seed              # demo society (logins 9000000001-4, password demo-pass-1)
npm run job -- sendDueReminders   # run any scheduled job by hand
```

Optional services (the API works without them):
- **Cloudinary** (`CLOUDINARY_*`): photo / receipt / document uploads. Without it, upload endpoints return 503.
- **Firebase** (`FIREBASE_SERVICE_ACCOUNT`): phone push notifications. Without it, notifications still land in the in-app inbox.
- **Jobs** (`ENABLE_JOBS=true` on exactly one server): dues, reminders, 48h complaint check, statements, weekly digest.

## Layout

```
src/
  config/       env (validated), db, logger, permissions matrix
  middleware/   auth, societyGuard, requireRole, validate, rateLimit, apiLog, errorHandler
  models/       one file per collection (17)
  modules/      auth, me, societies, members, families, invites, maintenance,
                finance, complaints, notices, documents, notifications
  services/     notify (inbox + FCM push), audit, storage (Cloudinary), recipients
  jobs/         jobs.ts (the 6 jobs), scheduler.ts (node-cron, IST)
  scripts/      seed, run-job
  utils/        money (paise), dates (IST), phone, ids, pagination, schemas, access
test/           API tests (Vitest + Supertest + mongodb-memory-server)
postman/        Postman collection with every endpoint
```

## Rules every module follows

- Society routes sit behind `societyGuard` at `/api/v1/societies/:societyId/...`.
  Inside them, filter by `req.membership.societyId`, never by an id from the body.
- Roles are checked with `requirePermission('<key>')` from `config/permissions.ts`.
- Money is integer paise everywhere (₹2,000 = 200000). Dates are calculated in IST.
- Payments and expenses are never deleted: they are rejected / voided, and the audit log records it.
- Errors are `{ error: { code, message, details } }`.

## Logs

- `apiLogs` collection: one row per request (method, path, route, status, duration, user, society, error code).
  Auto-deleted after `API_LOG_TTL_DAYS` (default 14). Turn off with `ENABLE_API_LOGS=false`.
- `auditLogs` collection: who changed what (payments, waivers, roles, families, expenses…). Kept forever.
  Admins can read it at `GET /societies/:id/audit-logs`.

## Endpoints

See `postman/basera-api.postman_collection.json` (import it into Postman) for every request with example bodies.
