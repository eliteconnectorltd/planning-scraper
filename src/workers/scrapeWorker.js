'use strict';

require('dotenv').config();

const { getApplications } = require('../planit');
const { detectPlatform } = require('../detector');
const applicationsRepository = require('../db/repositories/applicationsRepository');
const { queues } = require('./queues');
const { createManagedWorker } = require('./workerUtils');

async function processScrapeJob(job) {
  const { days = 4, limit = 5, location = process.env.LOCATION || '' } = job.data || {};
  await job.updateProgress(10);
  const applications = await getApplications(days, limit, location);
  await applicationsRepository.upsertApplications(applications);
  await job.updateProgress(45);

  for (const app of applications) {
    const platform = detectPlatform(app.docsUrl || app.sourceUrl);
    await applicationsRepository.upsertApplication({ ...app, platform, scrape_status: 'queued_download' });
    await queues.download.add('download-application', { application: app, platform });
  }

  return { applicationsQueued: applications.length };
}

if (require.main === module) {
  createManagedWorker('scrape', processScrapeJob, { defaultConcurrency: 1 });
}

module.exports = { processScrapeJob };
