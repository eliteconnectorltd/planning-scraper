'use strict';

/**
 * test_supabase.js — Standalone Supabase connectivity smoke-test.
 *
 * Run: node test_supabase.js
 *
 * Checks:
 *   1. Env vars present
 *   2. DB reachable (ping applications table)
 *   3. Insert one test application row
 *   4. Insert one test document row linked to that application
 *   5. Upload a small text file to Storage
 *   6. Read back the application + document from DB
 *   7. Read back (list) the file from Storage
 *   8. Clean up all test rows and the storage object
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const TEST_APP_UID   = '__test_supabase_smoke__';
const TEST_BUCKET    = process.env.SUPABASE_DOCUMENTS_BUCKET || 'planning-documents';
const TEST_FILE_PATH = `__test__/smoke_test.txt`;
const TEST_FILE_BODY = Buffer.from('Supabase smoke test — safe to delete.');

// ── helpers ──────────────────────────────────────────────────────────────────

function ok(label)   { console.log(`  ✓  ${label}`); }
function fail(label, err) { console.error(`  ✗  ${label}\n     ${err?.message || err}`); }

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n=== Supabase smoke test ===\n');
  let passed = 0;
  let failed = 0;

  // ── 1. Env vars ────────────────────────────────────────────────────────────
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('FATAL: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from .env');
    process.exit(1);
  }
  ok(`Env vars present  (URL: ${url})`);
  if (key.startsWith('sb_publishable_') || key.startsWith('sb_anon_')) {
    console.warn(
      '  ⚠  SUPABASE_SERVICE_ROLE_KEY looks like a PUBLISHABLE/anon key — inserts, reads under\n' +
      '     RLS, and bucket creation will likely fail. Use the SECRET service-role key\n' +
      '     (prefix "sb_secret_" or a legacy "eyJ…" JWT) from Project Settings → API.'
    );
  }
  passed++;

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout },
  });

  // ── 2. DB ping ─────────────────────────────────────────────────────────────
  try {
    const { error } = await client.from('applications').select('id', { count: 'exact', head: true });
    if (error) throw error;
    ok('DB reachable — applications table exists');
    passed++;
  } catch (err) {
    fail('DB ping failed', err);
    failed++;
    console.error('\nCannot reach Supabase DB. Check SUPABASE_URL and that the schema has been applied.\n');
    process.exit(1);
  }

  // Track inserted IDs for cleanup
  let appId = null;
  let docId = null;

  // ── 3. Insert application ──────────────────────────────────────────────────
  try {
    const { data, error } = await client
      .from('applications')
      .upsert({ application_uid: TEST_APP_UID, council: 'TestCouncil', platform: 'idox', scrape_status: 'test' },
               { onConflict: 'application_uid' })
      .select()
      .single();
    if (error) throw error;
    appId = data.id;
    ok(`Inserted application  (id: ${appId})`);
    passed++;
  } catch (err) {
    fail('Insert application failed', err);
    failed++;
  }

  // ── 4. Insert document ─────────────────────────────────────────────────────
  if (appId) {
    try {
      const { data, error } = await client
        .from('documents')
        .upsert({
          application_id: appId,
          document_name:  'Smoke Test Document',
          document_type:  'test',
          source_url:     'https://example.com/smoke_test.pdf',
          extraction_status: 'test',
        }, { onConflict: 'application_id,source_url' })
        .select()
        .single();
      if (error) throw error;
      docId = data.id;
      ok(`Inserted document  (id: ${docId})`);
      passed++;
    } catch (err) {
      fail('Insert document failed', err);
      failed++;
    }
  } else {
    fail('Insert document skipped — no application_id', new Error('dependency'));
    failed++;
  }

  // ── 5. Upload file to Storage ──────────────────────────────────────────────
  let storageOk = false;
  try {
    // Ensure bucket exists (create if needed)
    const { data: bucketData } = await client.storage.getBucket(TEST_BUCKET);
    if (!bucketData) {
      const { error: createErr } = await client.storage.createBucket(TEST_BUCKET, { public: false });
      if (createErr && !/already exists/i.test(createErr.message)) throw createErr;
    }
    const { error } = await client.storage.from(TEST_BUCKET).upload(TEST_FILE_PATH, TEST_FILE_BODY, {
      contentType: 'text/plain',
      upsert: true,
    });
    if (error) throw error;
    ok(`Uploaded file to Storage  (bucket: ${TEST_BUCKET}, path: ${TEST_FILE_PATH})`);
    passed++;
    storageOk = true;

    // Signed URL — this is exactly how the dashboard serves stored documents
    // (dashboard/src/lib/supabase-api.ts → createDocumentUrl()).
    const { data: signed, error: signErr } = await client.storage
      .from(TEST_BUCKET)
      .createSignedUrl(TEST_FILE_PATH, 60 * 60);
    if (signErr) throw signErr;
    ok(`Signed URL (valid 1h):\n     ${signed.signedUrl}`);
    passed++;
  } catch (err) {
    fail('Storage upload failed', err);
    failed++;
  }

  // ── 6. Read back application + document ───────────────────────────────────
  try {
    const { data, error } = await client
      .from('applications')
      .select('*, documents(*)')
      .eq('application_uid', TEST_APP_UID)
      .single();
    if (error) throw error;
    const docCount = (data.documents || []).length;
    ok(`Read back application with ${docCount} document(s)`);
    passed++;
  } catch (err) {
    fail('Read back application failed', err);
    failed++;
  }

  // ── 7. List / read back Storage file ──────────────────────────────────────
  if (storageOk) {
    try {
      const { data, error } = await client.storage.from(TEST_BUCKET).list('__test__');
      if (error) throw error;
      const found = (data || []).some(f => f.name === 'smoke_test.txt');
      if (!found) throw new Error('File not found in listing');
      ok('Listed Storage file — confirmed present');
      passed++;
    } catch (err) {
      fail('Storage list failed', err);
      failed++;
    }
  }

  // ── 8. Cleanup ─────────────────────────────────────────────────────────────
  console.log('\n  [cleanup]');
  if (docId) {
    const { error } = await client.from('documents').delete().eq('id', docId);
    if (error) console.warn(`  cleanup documents: ${error.message}`);
    else console.log('  deleted test document');
  }
  if (appId) {
    const { error } = await client.from('applications').delete().eq('id', appId);
    if (error) console.warn(`  cleanup applications: ${error.message}`);
    else console.log('  deleted test application');
  }
  if (storageOk) {
    const { error } = await client.storage.from(TEST_BUCKET).remove([TEST_FILE_PATH]);
    if (error) console.warn(`  cleanup storage: ${error.message}`);
    else console.log('  deleted test storage file');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
