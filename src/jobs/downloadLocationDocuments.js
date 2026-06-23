'use strict';

require('dotenv').config();

const { getClientOrNull } = require('../db/repositories/baseRepository');
const applicationsRepository = require('../db/repositories/applicationsRepository');
const { createBrowserContext } = require('../browser');
const { detectPlatform } = require('../detector');
const { scrapeIdoxDocuments } = require('../adapters/idox');
const { downloadDocument } = require('../download/downloadManager');
const runsRepository = require('../db/repositories/runsRepository');
const documentsRepository = require('../db/repositories/documentsRepository');

const MAX_APPLICATIONS = Number(process.env.MAX_LOCATION_DOCUMENT_APPLICATIONS) || 0;
const MAX_DOCS_PER_APPLICATION = Number(process.env.MAX_DOCS_PER_LOCATION_APPLICATION) || 0;
const APPLICATION_UIDS = (process.env.LOCATION_DOCUMENT_APPLICATION_UIDS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

function log(scope, message) {
  console.log(`[${scope}] ${message}`);
}

function toLegacyApp(row) {
  return {
    title: row.application_uid,
    application_uid: row.application_uid,
    area: row.council,
    address: row.address,
    description: row.proposal,
    sourceUrl: row.source_url,
    docsUrl: row.documents_url,
    platform: row.platform,
  };
}

async function getLocationExtractedApplications() {
  const client = getClientOrNull();
  if (!client) return [];

  let query = client
    .from('applications')
    .select('id, application_uid, council, platform, address, proposal, source_url, documents_url, scrape_status')
    .not('documents_url', 'is', null)
    .neq('documents_url', '')
    .order('updated_at', { ascending: false });

  if (APPLICATION_UIDS.length > 0) {
    query = query.in('application_uid', APPLICATION_UIDS);
  } else {
    query = query.eq('scrape_status', 'location_extracted');
  }

  if (MAX_APPLICATIONS > 0) query = query.limit(MAX_APPLICATIONS);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function processApplication(context, row, manifest) {
  const docsUrl = row.documents_url;
  const platform = detectPlatform(docsUrl);
  const app = toLegacyApp(row);

  log('DOCUMENTS', `Processing ${row.application_uid}`);
  log('PLATFORM', `Detected ${platform.toUpperCase()} for documents`);

  if (platform !== 'idox') {
    await applicationsRepository.upsertApplication({ ...app, scrape_status: 'documents_unsupported' });
    log('DOCUMENTS', `Unsupported document platform for ${row.application_uid}`);
    return { extracted: 0, downloaded: 0, failed: 0, unsupported: 1 };
  }

  const page = await context.newPage();
  try {
    const result = await scrapeIdoxDocuments(page, docsUrl);
    const docs = (result.documents || [])
      .slice(0, MAX_DOCS_PER_APPLICATION > 0 ? MAX_DOCS_PER_APPLICATION : undefined);
    log('EXTRACT', `Found ${docs.length} documents for ${row.application_uid}`);

    let downloaded = 0;
    let failed = 0;

    for (const doc of docs) {
      const record = await downloadDocument(doc, app, row.council || 'Unknown', manifest, context);
      if (record.status === 'downloaded' || record.status === 'skipped_duplicate') downloaded++;
      if (record.status === 'failed') failed++;

      await documentsRepository.upsertDocument({
        ...record,
        name: doc.name,
        type: doc.type,
        category: doc.type,
        date: doc.date,
        url: doc.url,
        sourceUrl: doc.url,
        confidence: doc.confidence,
      }, row.id).catch(err => log('SUPABASE', `Document metadata update skipped for ${doc.name}: ${err.message}`));

      manifest.files = manifest.files || [];
      if (record.sourceUrl && !manifest.files.some(file => file.sourceUrl === record.sourceUrl)) {
        manifest.files.push(record);
      }
    }

    await applicationsRepository.upsertApplication({
      ...app,
      platform,
      scrape_status: docs.length > 0 ? 'documents_downloaded' : 'documents_empty',
    });

    log('SUPABASE', `Saved documents for ${row.application_uid}: downloaded=${downloaded}, failed=${failed}`);
    return { extracted: docs.length, downloaded, failed, unsupported: 0 };
  } catch (err) {
    await applicationsRepository.upsertApplication({ ...app, platform, scrape_status: 'documents_failed' }).catch(() => {});
    log('DOCUMENTS', `Failed ${row.application_uid}: ${err.message}`);
    return { extracted: 0, downloaded: 0, failed: 1, unsupported: 0 };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const startedAt = Date.now();
  const metrics = {
    applications: 0,
    documentsExtracted: 0,
    downloadsCompleted: 0,
    failures: 0,
    unsupported: 0,
  };

  const run = await runsRepository.startRun({ run_status: 'location_document_download_running' }).catch(err => {
    log('SUPABASE', `Run tracking unavailable: ${err.message}`);
    return null;
  });

  const applications = await getLocationExtractedApplications();
  log('DOCUMENTS', `Loaded ${applications.length} location-extracted applications with document URLs`);

  let context = null;
  const manifest = { generatedAt: new Date().toISOString(), files: [], metrics: {} };

  try {
    context = await createBrowserContext({
      sessionId: 'phase10_location_documents',
      headless: process.env.HEADLESS === 'true',
    });

    for (const app of applications) {
      metrics.applications++;
      const result = await processApplication(context, app, manifest);
      metrics.documentsExtracted += result.extracted;
      metrics.downloadsCompleted += result.downloaded;
      metrics.failures += result.failed;
      metrics.unsupported += result.unsupported;
    }
  } finally {
    if (context) await context.close().catch(() => {});
  }

  const runtimeSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(2));
  await runsRepository.completeRun(run && run.id, {
    totalApplications: metrics.applications,
    totalDocuments: metrics.documentsExtracted,
    successfulDownloads: metrics.downloadsCompleted,
    failedDownloads: metrics.failures,
    runtimeSeconds,
    run_status: metrics.failures > 0 ? 'completed_with_failures' : 'completed',
  }).catch(err => log('SUPABASE', `Run completion skipped: ${err.message}`));

  log('DOCUMENTS', `Complete applications=${metrics.applications} extracted=${metrics.documentsExtracted} downloaded=${metrics.downloadsCompleted} failures=${metrics.failures} unsupported=${metrics.unsupported}`);
}

main().catch(err => {
  log('DOCUMENTS', `Fatal: ${err.message}`);
  process.exit(1);
});
