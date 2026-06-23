'use strict';

const assert = require('assert');
const { getConcurrency } = require('../src/workers/workerUtils');

console.log('=== Phase 9 Queue Tests ===');
const previous = process.env.WORKER_CONCURRENCY;
process.env.WORKER_CONCURRENCY = '7';
assert.equal(getConcurrency(3), 7);
process.env.WORKER_CONCURRENCY = '';
assert.equal(getConcurrency(4), 4);
if (previous === undefined) {
  delete process.env.WORKER_CONCURRENCY;
} else {
  process.env.WORKER_CONCURRENCY = previous;
}
console.log('Phase 9 queue configuration tests passed');
