'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getSupabaseClient } = require('../db/supabase');
const { uploadDocumentFile } = require('../db/storage');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function resolveLocalPath(localPath) {
  if (!localPath) return null;
  return path.isAbsolute(localPath) ? localPath : path.join(PROJECT_ROOT, localPath);
}

async function main() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const { data, error } = await client
    .from('documents')
    .select('id, document_name, local_path, mime_type, sha256_hash, storage_path, applications(application_uid, council)')
    .order('created_at', { ascending: false });

  if (error) throw error;

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of data || []) {
    if (doc.storage_path) {
      skipped++;
      continue;
    }

    const absolutePath = resolveLocalPath(doc.local_path);
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      console.warn(`[storage] missing local file for ${doc.document_name}: ${doc.local_path || '(empty)'}`);
      failed++;
      continue;
    }

    const app = Array.isArray(doc.applications) ? doc.applications[0] : doc.applications;

    try {
      const storageRecord = await uploadDocumentFile({
        absolutePath,
        fileName: doc.document_name || path.basename(absolutePath),
        council: app && app.council,
        applicationUid: app && app.application_uid,
        sha256: doc.sha256_hash,
        mimeType: doc.mime_type || 'application/pdf',
      });

      if (!storageRecord) {
        skipped++;
        continue;
      }

      const { error: updateError } = await client
        .from('documents')
        .update({
          storage_bucket: storageRecord.storageBucket,
          storage_path: storageRecord.storagePath,
          storage_mime_type: storageRecord.storageMimeType,
          storage_uploaded_at: storageRecord.storageUploadedAt,
        })
        .eq('id', doc.id);

      if (updateError) throw updateError;

      uploaded++;
      console.log(`[storage] uploaded ${doc.document_name} -> ${storageRecord.storagePath}`);
    } catch (err) {
      failed++;
      console.warn(`[storage] failed ${doc.document_name}: ${err.message}`);
    }
  }

  console.log(`[storage] complete uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
}

main().catch(err => {
  console.error(`[storage] fatal: ${err.message}`);
  process.exit(1);
});
