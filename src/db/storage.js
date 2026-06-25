'use strict';

const fs = require('fs');
const path = require('path');
const { getSupabaseClient } = require('./supabase');

const DEFAULT_BUCKET = process.env.SUPABASE_DOCUMENTS_BUCKET || 'planning-documents';

let bucketReady = false;

function normalizeStoragePart(value, fallback = 'unknown') {
  return String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|#%{}^~[\]`;\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

// Strips parameters from a MIME type so it matches the bucket's allowedMimeTypes
// gate ("application/pdf; charset=utf-8" → "application/pdf"). Duplicated from
// downloadManager.js intentionally to avoid a circular require (downloadManager
// already requires this module).
function normalizeMimeType(mime) {
  if (!mime || typeof mime !== 'string') return 'application/octet-stream';
  return mime.split(';')[0].trim().toLowerCase();
}

async function ensureDocumentsBucket(client, bucket = DEFAULT_BUCKET) {
  if (bucketReady) return;

  const { data } = await client.storage.getBucket(bucket);
  if (!data) {
    const { error } = await client.storage.createBucket(bucket, {
      public: false,
      fileSizeLimit: 52428800,
      allowedMimeTypes: [
        'application/pdf',
        'application/octet-stream',
        'image/png', 'image/jpeg', 'image/gif', 'image/tiff', 'image/webp',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/zip',
      ],
    });
    if (error && !/already exists/i.test(error.message || '')) throw error;
  }

  bucketReady = true;
}

async function uploadDocumentFile(options = {}) {
  const client = getSupabaseClient();
  if (!client) return null;

  // Accept bytes directly (Storage-only path) or fall back to reading from disk
  // for any legacy caller that still passes an absolutePath.
  let buffer = options.buffer;
  if (!buffer) {
    if (!options.absolutePath || !fs.existsSync(options.absolutePath)) return null;
    buffer = fs.readFileSync(options.absolutePath);
  }
  if (!buffer || buffer.length === 0) return null;

  const bucket = options.bucket || DEFAULT_BUCKET;
  await ensureDocumentsBucket(client, bucket);

  const nameForExt = options.fileName || options.absolutePath || 'document.pdf';
  const extension = path.extname(nameForExt) || '.pdf';
  const baseName = normalizeStoragePart(path.basename(nameForExt, extension), 'document');
  const council = normalizeStoragePart(options.council, 'unknown_council');
  const application = normalizeStoragePart(options.applicationUid, 'unknown_application');
  const hashPart = normalizeStoragePart((options.sha256 || 'unhashed').slice(0, 16), 'unhashed');
  const objectPath = `${council}/${application}/${hashPart}/${baseName}${extension}`;

  // The bucket's allowedMimeTypes gate matches the BARE type only — strip any
  // parameters (e.g. "application/pdf; charset=utf-8" → "application/pdf") before
  // sending to the upload API, or Storage rejects it. We still keep the original
  // (with parameters) in storageMimeType / storage_mime_type for accuracy.
  const rawMimeType = options.mimeType || 'application/pdf';
  const uploadContentType = normalizeMimeType(rawMimeType);

  const { error } = await client.storage.from(bucket).upload(objectPath, buffer, {
    cacheControl: '3600',
    contentType: uploadContentType,
    upsert: true,
  });

  if (error) throw error;

  return {
    storageBucket: bucket,
    storagePath: objectPath,
    storageMimeType: rawMimeType,
    storageUploadedAt: new Date().toISOString(),
  };
}

/**
 * Downloads a document's bytes from Supabase Storage.
 *
 * @param {string} storagePath - Object key within the bucket
 * @param {string} [bucket] - Bucket name (defaults to DEFAULT_BUCKET)
 * @returns {Promise<Buffer|null>} - File bytes, or null if unavailable
 */
async function downloadDocumentFile(storagePath, bucket = DEFAULT_BUCKET) {
  const client = getSupabaseClient();
  if (!client || !storagePath) return null;

  const { data, error } = await client.storage.from(bucket).download(storagePath);
  if (error || !data) return null;

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = {
  DEFAULT_BUCKET,
  uploadDocumentFile,
  downloadDocumentFile,
};
