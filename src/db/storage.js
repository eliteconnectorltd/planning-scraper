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

  const { error } = await client.storage.from(bucket).upload(objectPath, buffer, {
    cacheControl: '3600',
    contentType: options.mimeType || 'application/pdf',
    upsert: true,
  });

  if (error) throw error;

  return {
    storageBucket: bucket,
    storagePath: objectPath,
    storageMimeType: options.mimeType || 'application/pdf',
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
