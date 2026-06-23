'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getSupabaseClient } = require('../db/supabase');
const { DEFAULT_BUCKET } = require('../db/storage');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const OUTPUT_FILES = [
  'output/results.json',
  'output/master_dataset.json',
  'output/prev_master_dataset.json',
  'output/change_log.json',
  'output/download_manifest.json',
  'output/intelligence_manifest.json',
  'output/run_summary.json',
].map(file => path.join(PROJECT_ROOT, file));

const OUTPUT_DIRS = [
  path.join(PROJECT_ROOT, 'output', 'downloads'),
  path.join(PROJECT_ROOT, 'output', 'intelligence'),
];

async function clearStorage(client) {
  const bucket = process.env.SUPABASE_DOCUMENTS_BUCKET || DEFAULT_BUCKET;
  const { data: bucketData } = await client.storage.getBucket(bucket);
  if (!bucketData) return;

  async function removePrefix(prefix = '') {
    const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) throw error;
    const entries = data || [];
    const files = entries.filter(item => !item.id).map(item => `${prefix}${item.name}`);
    const folders = entries.filter(item => item.id).map(item => `${prefix}${item.name}/`);

    if (files.length > 0) {
      const { error: removeError } = await client.storage.from(bucket).remove(files);
      if (removeError) throw removeError;
    }

    for (const folder of folders) {
      await removePrefix(folder);
    }
  }

  await removePrefix('');
}

async function clearDatabase(client) {
  for (const table of ['intelligence', 'documents', 'change_log', 'platform_metrics', 'scraping_runs', 'applications']) {
    const { error } = await client.from(table).delete().not('id', 'is', null);
    if (error) throw new Error(`Failed clearing ${table}: ${error.message}`);
  }
}

function clearLocalFiles() {
  for (const dir of OUTPUT_DIRS) {
    const resolved = path.resolve(dir);
    const outputRoot = path.resolve(PROJECT_ROOT, 'output');
    if (fs.existsSync(resolved) && resolved.startsWith(outputRoot + path.sep)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }

  for (const file of OUTPUT_FILES) {
    if (!fs.existsSync(file)) continue;
    const emptyValue = file.endsWith('change_log.json') || file.endsWith('master_dataset.json') || file.endsWith('prev_master_dataset.json') || file.endsWith('results.json')
      ? '[]\n'
      : '{}\n';
    fs.writeFileSync(file, emptyValue, 'utf8');
  }
}

async function main() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  await clearStorage(client);
  await clearDatabase(client);
  clearLocalFiles();
  console.log('Reset complete: Supabase tables, Supabase Storage objects, and local output files were cleared.');
}

main().catch(err => {
  console.error(`Reset failed: ${err.message}`);
  process.exit(1);
});
