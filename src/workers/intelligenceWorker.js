'use strict';

require('dotenv').config();

const { processDocumentIntelligence } = require('../intelligence');
const { createManagedWorker } = require('./workerUtils');

async function processIntelligenceJob(job) {
  await job.updateProgress(10);
  const manifest = await processDocumentIntelligence(job.data || {});
  return {
    totalDocumentsProcessed: manifest.summary.totalDocumentsProcessed,
    failedOcrCount: manifest.summary.failedOcrCount,
  };
}

if (require.main === module) {
  createManagedWorker('intelligence', processIntelligenceJob, { defaultConcurrency: 2 });
}

module.exports = { processIntelligenceJob };
