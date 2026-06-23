'use strict';

require('dotenv').config();

const { queues } = require('./queues');
const { createManagedWorker } = require('./workerUtils');

async function processRetryJob(job) {
  const { targetQueue, jobName, data, delayMs = 300000 } = job.data || {};
  if (!targetQueue || !queues[targetQueue]) throw new Error(`Unknown retry target queue: ${targetQueue}`);
  await queues[targetQueue].add(jobName || 'retry-job', data || {}, {
    delay: delayMs,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60000 },
  });
  return { requeued: targetQueue, delayMs };
}

if (require.main === module) {
  createManagedWorker('retry', processRetryJob, { defaultConcurrency: 1 });
}

module.exports = { processRetryJob };
