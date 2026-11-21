import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { DOCUMENT_CATEGORIES, DocumentModel, MAX_DOCUMENT_BYTES } from '../../models/document.js';
import { FamilyModel } from '../../models/family.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { adminUserIds, allMemberUserIds } from '../../services/recipients.js';
import { privateDownloadUrl, signUpload } from '../../services/storage.js';
import { isAdmin, member } from '../../utils/access.js';
import { badRequest, forbidden, notFound } from '../../utils/errors.js';
import { PaginationQuery, pageResult, skipFor } from '../../utils/pagination.js';
import { ObjectIdSchema } from '../../utils/schemas.js';

/** Mounted at /societies/:societyId/documents */
export const documentsRouter = Router({ mergeParams: true });
const IdParams = z.object({ id: ObjectIdSchema });

/**
 * Who sees what:
 *  - committee: everything
 *  - residents: "all residents" committee papers + whatever their own family shared
 */
function visibleTo(req: Request): Record<string, unknown> {
  if (isAdmin(req)) return {};
  const { familyId } = member(req);
  return familyId ? { $or: [{ visibility: 'residents', familyId: null }, { familyId }] } : { visibility: 'residents', familyId: null };
}

const ListQuery = PaginationQuery.extend({
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  source: z.enum(['committee', 'residents']).optional(), // committee papers vs files sent by residents
});

documentsRouter.get('/', validate({ query: ListQuery }), async (req, res) => {
  const q = req.valid!.query as z.infer<typeof ListQuery>;
  const filter: Record<string, unknown> = { societyId: member(req).societyId, isDeleted: false, ...visibleTo(req) };
  if (q.category) filter.category = q.category;
  if (q.source === 'committee') filter.familyId = null;
  if (q.source === 'residents') filter.familyId = { $ne: null };
  const [items, total] = await Promise.all([
    DocumentModel.find(filter).sort({ createdAt: -1 }).skip(skipFor(q)).limit(q.limit).populate('uploadedBy', 'name').populate('familyId', 'unitNumber head.name'),
    DocumentModel.countDocuments(filter),
  ]);
  res.json(pageResult(items, total, q));
});

/** Step 1: signed parameters to upload the file straight into private storage. Any member may upload. */
documentsRouter.post('/upload-url', async (req, res) => {
  res.json(signUpload(String(member(req).societyId), 'document'));
});

const CreateBody = z.strictObject({
  title: z.string().trim().min(2).max(150),
  category: z.enum(DOCUMENT_CATEGORIES).default('other'),
  visibility: z.enum(['admins', 'residents']).default('admins'),
  fileKey: z.string().min(3).max(300), // Cloudinary public_id from the upload response
  resourceType: z.enum(['image', 'raw', 'video']).default('raw'),
  format: z.string().max(10).optional(),
  mimeType: z.string().max(100).optional(),
  sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES, 'Files can be at most 20 MB').optional(),
  notifyResidents: z.boolean().default(false),
});

/**
 * Step 2: save the record after the upload finished.
 * Committee uploads choose visibility. A resident's upload is always "committee + my family only".
 */
documentsRouter.post('/', validate({ body: CreateBody }), async (req, res) => {
  const { notifyResidents, ...body } = req.valid!.body as z.infer<typeof CreateBody>;
  const m = member(req);
  const admin = isAdmin(req);
  if (!body.fileKey.startsWith(`basera/${m.societyId}/document/`)) {
    throw badRequest('BAD_FILE_KEY', 'Upload the file with the link from /documents/upload-url first');
  }
  if (!admin && !m.familyId) throw forbidden('NO_FAMILY', 'Join a house before sharing documents');

  const doc = await DocumentModel.create({
    ...body,
    visibility: admin ? body.visibility : 'admins',
    familyId: admin ? null : m.familyId,
    societyId: m.societyId,
    uploadedBy: req.userId,
  });
  await audit({ societyId: m.societyId, actorId: req.userId!, action: 'document.uploaded', entity: 'document', entityId: doc._id, after: { title: body.title, visibility: doc.visibility, familyId: doc.familyId } });

  if (!admin) {
    const family = await FamilyModel.findById(m.familyId, { unitNumber: 1 }).lean();
    await notify({
      userIds: await adminUserIds(m.societyId), societyId: m.societyId, type: 'document_shared',
      title: 'Document from a resident', body: `${family?.unitNumber}: ${doc.title}`, data: { documentId: String(doc._id) },
    });
  } else if (notifyResidents && doc.visibility === 'residents') {
    await notify({
      userIds: await allMemberUserIds(m.societyId), societyId: m.societyId, type: 'document_shared',
      title: 'New document', body: `${doc.title} added`, data: { documentId: String(doc._id) }, excludeUserId: req.userId,
    });
  }
  res.status(201).json({ document: doc });
});

async function loadVisible(req: Request, id: string) {
  const filter: Record<string, unknown> = { _id: id, societyId: member(req).societyId, isDeleted: false, ...visibleTo(req) };
  const doc = await DocumentModel.findOne(filter);
  if (!doc) throw notFound('Document'); // also for docs the caller may not see: don't reveal they exist
  return doc;
}

/** A link that works for ~10 minutes, after checking the caller may see this document. */
documentsRouter.get('/:id/download', validate({ params: IdParams }), async (req, res) => {
  const doc = await loadVisible(req, req.valid!.params.id);
  res.json(privateDownloadUrl(doc.fileKey, { format: doc.format, resourceType: doc.resourceType, ttlSeconds: 600 }));
});

const PatchBody = z
  .strictObject({
    title: z.string().trim().min(2).max(150).optional(),
    category: z.enum(DOCUMENT_CATEGORIES).optional(),
    visibility: z.enum(['admins', 'residents']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

documentsRouter.patch('/:id', requirePermission('documents.manage'), validate({ params: IdParams, body: PatchBody }), async (req, res) => {
  const { societyId } = member(req);
  const doc = await DocumentModel.findOne({ _id: req.valid!.params.id, societyId, isDeleted: false });
  if (!doc) throw notFound('Document');
  if (doc.familyId && req.valid!.body.visibility === 'residents') {
    throw badRequest('PRIVATE_DOCUMENT', 'A document shared by a family stays private to the committee');
  }
  const before = { title: doc.title, category: doc.category, visibility: doc.visibility };
  doc.set(req.valid!.body);
  await doc.save();
  await audit({ societyId, actorId: req.userId!, action: 'document.updated', entity: 'document', entityId: doc._id, before, after: req.valid!.body });
  res.json({ document: doc });
});

/** Committee can delete any document; a resident only one their family shared. */
documentsRouter.delete('/:id', validate({ params: IdParams }), async (req, res) => {
  const doc = await loadVisible(req, req.valid!.params.id);
  if (!isAdmin(req) && !doc.familyId) throw forbidden('WRONG_ROLE', 'Only the committee can delete this');
  doc.isDeleted = true;
  await doc.save();
  await audit({ societyId: doc.societyId, actorId: req.userId!, action: 'document.deleted', entity: 'document', entityId: doc._id, before: { title: doc.title } });
  res.status(204).end();
});
