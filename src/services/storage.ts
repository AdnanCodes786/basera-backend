import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { randomToken } from '../utils/ids.js';

/**
 * Files go straight from the app to Cloudinary. The API only signs the upload
 * (so nobody can upload without asking us) and stores the resulting URL / key.
 *
 * - Public uploads (complaint photos, expense receipts, notice images): normal URLs.
 * - Private uploads (society documents): type "authenticated", only reachable through
 *   short-lived signed download links from the API.
 */
function configured(): boolean {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

function ensureConfigured() {
  if (!configured()) {
    throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'File uploads are not set up on the server yet');
  }
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export type UploadPurpose = 'complaint' | 'payment' | 'expense' | 'notice' | 'document';

/** Parameters the app posts (with the file) to https://api.cloudinary.com/v1_1/<cloud>/<resourceType>/upload */
export function signUpload(societyId: string, purpose: UploadPurpose) {
  ensureConfigured();
  const isPrivate = purpose === 'document';
  const timestamp = Math.floor(Date.now() / 1000);
  const params: Record<string, string | number> = {
    timestamp,
    folder: `basera/${societyId}/${purpose}`,
    public_id: randomToken(12),
    ...(isPrivate ? { type: 'authenticated' } : {}),
  };
  const signature = cloudinary.utils.api_sign_request(params, env.CLOUDINARY_API_SECRET);
  const resourceType = isPrivate ? 'auto' : 'image';
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
    fields: { ...params, api_key: env.CLOUDINARY_API_KEY, signature },
    expiresInSeconds: 3600,
  };
}

/** A download link for a private document that stops working after `ttlSeconds`. */
export function privateDownloadUrl(
  fileKey: string,
  opts: { format?: string | null; resourceType?: string | null; ttlSeconds?: number },
): { url: string; expiresAt: Date } {
  ensureConfigured();
  const expiresAt = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 600);
  const url = cloudinary.utils.private_download_url(fileKey, opts.format ?? '', {
    resource_type: opts.resourceType ?? 'raw',
    type: 'authenticated',
    expires_at: expiresAt,
  });
  return { url, expiresAt: new Date(expiresAt * 1000) };
}

/** True if the URL points at our own Cloudinary account (so users can't attach arbitrary links). */
export function isOurUpload(url: string): boolean {
  if (!configured()) return true; // storage not set up yet: accept any https URL during development
  return url.startsWith(`https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/`);
}
