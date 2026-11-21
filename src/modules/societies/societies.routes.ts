import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { authRateLimit } from '../../middleware/rateLimit.js';
import { requirePermission } from '../../middleware/requireRole.js';
import { societyGuard } from '../../middleware/societyGuard.js';
import { validate } from '../../middleware/validate.js';
import { SocietyModel } from '../../models/society.js';
import { audit } from '../../services/audit.js';
import { member } from '../../utils/access.js';
import { notFound } from '../../utils/errors.js';
import { PhoneSchema } from '../../utils/phone.js';
import { complaintsRouter, uploadsRouter } from '../complaints/complaints.routes.js';
import { deskRouter } from '../desk/desk.routes.js';
import { documentsRouter } from '../documents/documents.routes.js';
import { familiesRouter } from '../families/families.routes.js';
import { auditRouter, financeRouter } from '../finance/finance.routes.js';
import { invitesRouter } from '../invites/invites.routes.js';
import { duesRouter, maintenanceRouter, paymentsRouter } from '../maintenance/maintenance.routes.js';
import { membersRouter } from '../members/members.routes.js';
import { noticesRouter } from '../notices/notices.routes.js';
import { CreateSocietyBody, UpdateSocietyBody } from './societies.schemas.js';
import * as societies from './societies.service.js';

/** Mounted at /api/v1/societies */
export const societiesRouter = Router();
societiesRouter.use(authenticate);

societiesRouter.post('/', validate({ body: CreateSocietyBody }), async (req, res) => {
  const { society, membership } = await societies.createSociety(req.userId!, req.valid!.body);
  res.status(201).json({ society, membership });
});

const JoinBody = z.strictObject({
  joinCode: z.string().trim().toUpperCase().length(8),
  unitNumber: z.string().trim().min(1).max(30),
});

/** Backup path when there is no invite link: lands as PENDING until an admin approves and picks the family. */
societiesRouter.post('/join', authRateLimit, validate({ body: JoinBody }), async (req, res) => {
  const membership = await societies.requestToJoin(req.userId!, req.valid!.body);
  res.status(201).json({ membership });
});

/**
 * Everything under /societies/:societyId goes through the society guard.
 * Feature modules mount on `scoped`.
 */
export const scoped = Router({ mergeParams: true });
societiesRouter.use('/:societyId', societyGuard, scoped);

scoped.get('/', async (req, res) => {
  const { societyId, role } = member(req);
  res.json({ society: await societies.getSociety(societyId, role), myRole: role, myFamilyId: member(req).familyId });
});

scoped.patch('/', requirePermission('society.edit'), validate({ body: UpdateSocietyBody }), async (req, res) => {
  res.json({ society: await societies.updateSociety(member(req).societyId, req.valid!.body) });
});

scoped.post('/join-code/regenerate', requirePermission('society.edit'), async (req, res) => {
  res.json({ joinCode: await societies.regenerateJoinCode(member(req).societyId) });
});

// ---- Useful contacts (plumber, electrician, agency): small list embedded in the society ----

scoped.get('/contacts', async (req, res) => {
  const society = await SocietyModel.findById(member(req).societyId, { contacts: 1 }).lean();
  if (!society) throw notFound('Society');
  res.json({ contacts: society.contacts ?? [] });
});

const ContactsBody = z.strictObject({
  contacts: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(100),
        service: z.string().trim().min(1).max(60),
        phone: PhoneSchema,
      }),
    )
    .max(100),
});

scoped.put('/contacts', requirePermission('contacts.manage'), validate({ body: ContactsBody }), async (req, res) => {
  const { societyId } = member(req);
  const { contacts } = req.valid!.body as z.infer<typeof ContactsBody>;
  await SocietyModel.updateOne({ _id: societyId }, { $set: { contacts } });
  await audit({ societyId, actorId: req.userId!, action: 'contacts.updated', entity: 'society', entityId: societyId, after: { count: contacts.length } });
  res.json({ contacts });
});

// ---- Feature modules ----
scoped.use('/desk', deskRouter);
scoped.use('/members', membersRouter);
scoped.use('/families', familiesRouter);
scoped.use('/invites', invitesRouter);
scoped.use('/maintenance', maintenanceRouter);
scoped.use('/dues', duesRouter);
scoped.use('/payments', paymentsRouter);
scoped.use('/', financeRouter); // /expenses, /income, /statement, /finance
scoped.use('/complaints', complaintsRouter);
scoped.use('/uploads', uploadsRouter);
scoped.use('/notices', noticesRouter);
scoped.use('/documents', documentsRouter);
scoped.use('/audit-logs', auditRouter);
