'use strict';

const { Worker } = require('bullmq');
const { createConnection, moveToDeadLetter } = require('./queues');
const { logger } = require('../core/logger');

function getConcurrency(defaultValue = 3) {
  return Number(process.env.WORKER_CONCURRENCY || defaultValue);
}

function createManagedWorker(queueName, processor, options = {}) {
  const worker = new Worker(queueName, async job => {
    const startedAt = Date.now();
    logger.info('worker.job.started', { queue: queueName, job_id: job.id, job_name: job.name });
    try {
      const result = await processor(job);
      await job.updateProgress(100);
      logger.info('worker.job.completed', {
        queue: queueName,
        job_id: job.id,
        runtime_ms: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      logger.error('worker.job.failed', {
        queue: queueName,
        job_id: job.id,
        attempts_made: job.attemptsMade,
        error: err.message,
      });
      throw err;
    }
  }, {
    connection: createConnection(),
    concurrency: options.concurrency || getConcurrency(options.defaultConcurrency),
    limiter: options.limiter,
  });

  worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
      await moveToDeadLetter(job, err && err.message).catch(() => {});
    }
  });

  const shutdown = async () => {
    logger.info('worker.shutdown', { queue: queueName });
    await worker.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return worker;
}

module.exports = {
  createManagedWorker,
  getConcurrency,
};
