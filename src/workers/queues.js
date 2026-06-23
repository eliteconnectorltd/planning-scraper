'use strict';

const { Queue, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function createConnection() {
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

function createQueue(name) {
  return new Queue(name, {
    connection: createConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: 500,
      removeOnFail: false,
    },
  });
}

const queueCache = {};

function getQueue(key) {
  const names = {
    scrape: 'scrape',
    download: 'download',
    intelligence: 'intelligence',
    retry: 'retry',
    deadLetter: 'dead-letter',
  };
  if (!names[key]) throw new Error(`Unknown queue key: ${key}`);
  if (!queueCache[key]) {
    queueCache[key] = createQueue(names[key]);
  }
  return queueCache[key];
}

const queues = new Proxy({}, {
  get(_target, prop) {
    return getQueue(prop);
  },
});

function createEvents(name) {
  return new QueueEvents(name, { connection: createConnection() });
}

async function moveToDeadLetter(job, reason) {
  await queues.deadLetter.add('failed-job', {
    queue: job.queueName,
    name: job.name,
    data: job.data,
    failedReason: reason || job.failedReason,
    attemptsMade: job.attemptsMade,
    movedAt: new Date().toISOString(),
  });
}

module.exports = {
  createConnection,
  createQueue,
  createEvents,
  queues,
  moveToDeadLetter,
};
