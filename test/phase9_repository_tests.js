'use strict';

const assert = require('assert');
const applicationsRepository = require('../src/db/repositories/applicationsRepository');
const documentsRepository = require('../src/db/repositories/documentsRepository');
const intelligenceRepository = require('../src/db/repositories/intelligenceRepository');

console.log('=== Phase 9 Repository Tests ===');

const app = applicationsRepository.mapApplication({
  title: 'APP/1',
  area: 'Test Council',
  description: 'Build a test extension',
  sourceUrl: 'https://example.test/app',
  docsUrl: 'https://example.test/docs',
  startDate: '2026-05-01',
});
assert.equal(app.application_uid, 'APP/1');
assert.equal(app.council, 'Test Council');
assert.equal(app.proposal, 'Build a test extension');
assert.equal(app.source_url, 'https://example.test/app');

const doc = documentsRepository.mapDocument({
  name: 'Decision Notice',
  type: 'Decision Notice',
  url: 'https://example.test/doc.pdf',
  confidence: 'HIGH',
  sha256: 'abc123',
  sizeBytes: 12,
}, 'app-id');
assert.equal(doc.application_id, 'app-id');
assert.equal(doc.document_name, 'Decision Notice');
assert.equal(doc.confidence_score, 0.9);
assert.equal(doc.sha256_hash, 'abc123');

const intel = intelligenceRepository.mapIntelligence({
  metadata: { decision: 'GRANTED' },
  classification: { category: 'Decision Notice', confidence: 0.88 },
  ocr: { isScanned: false },
}, 'doc-id');
assert.equal(intel.document_id, 'doc-id');
assert.equal(intel.confidence_score, 0.88);
assert.deepEqual(intel.metadata_json, { decision: 'GRANTED' });

console.log('Phase 9 repository mapping tests passed');
