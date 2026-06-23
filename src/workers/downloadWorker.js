'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createBrowserContext } = require('../browser');
const { scrapeIdoxDocuments } = require('../adapters/idox');
const { downloadDocument } = require('../download/downloadManager');
const { queues } = require('./queues');
const { createManagedWorker } = require('./workerUtils');

const MANIFEST_PATH = path.join(__dirname, '..', '..', 'output', 'download_manifest.json');

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return { generatedAt: new Date().toISOString(), files: [], metrics: {} };
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return { generatedAt: new Date().toISOString(), files: [], metrics: {} };
  }
}

async function processDownloadJob(job) {
  const { application, platform } = job.data || {};
  if (!application) throw new Error('Missing application payload');
  const scrapeUrl = application.docsUrl || application.sourceUrl;
  if (!scrapeUrl) throw new Error('Missing application docs/source URL');

  const manifest = loadManifest();
  let context = null;
  try {
    context = await createBrowserContext({ headless: platform !== 'idox', sessionId: `worker_${application.title}` });
    const page = await context.newPage();
    await job.updateProgress(20);
    const docsObject = platform === 'idox'
      ? await scrapeIdoxDocuments(page, scrapeUrl)
      : { documents: application.documents || [], metrics: { success: true } };

    const documents = docsObject.documents || [];
    await job.updateProgress(45);
    let completed = 0;
    for (const doc of documents) {
      const record = await downloadDocument(doc, application, application.area || 'Unknown', manifest, context);
      manifest.files = manifest.files || [];
      manifest.files.push(record);
      completed++;
      await job.updateProgress(45 + Math.round((completed / Math.max(documents.length, 1)) * 45));
      await queues.intelligence.add('intelligence-document', { application, document: doc });
    }
    fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    return { documents: documents.length };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

if (require.main === module) {
  createManagedWorker('download', processDownloadJob);
}

module.exports = { processDownloadJob };
