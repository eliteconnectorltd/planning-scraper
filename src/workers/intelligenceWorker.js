'use strict';

require('dotenv').config();

const { processDocumentIntelligence } = require('../intelligence');
const { createManagedWorker } = require('./workerUtils');

async function processIntelligenceJob(job) {
  await job.updateProgress(10);
  // processDocumentIntelligence() returns a FLAT summary object (no `.summary`
  // wrapper): { totalDocumentsProcessed, successfullyExtractedText,
  // scannedPdfsCount, failedCount, classificationBreakdown }. Align to it.
  const summary = await processDocumentIntelligence();
  return {
    totalDocumentsProcessed: summary.totalDocumentsProcessed,
    successfullyExtractedText: summary.successfullyExtractedText,
    scannedPdfsCount: summary.scannedPdfsCount,
    failedCount: summary.failedCount,
  };
}

if (require.main === module) {
  createManagedWorker('intelligence', processIntelligenceJob, { defaultConcurrency: 2 });
}

module.exports = { processIntelligenceJob };
