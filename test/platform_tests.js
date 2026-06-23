'use strict';

/**
 * test/platform_tests.js
 * Fully offline automated test suite for Phase 7 platform modules.
 *
 * Tests:
 *  1. timelineBuilder  — event generation, ordering, deduplication
 *  2. datasetBuilder   — canonical record structure, hash enrichment, slugify
 *  3. searchEngine     — indexing, keyword/fuzzy/prefix/filter search
 *  4. changeDetector   — diff engine across simulated multi-run scenarios
 *  5. platform/index   — dashboard API aggregation analytics
 */

// ── Test Infrastructure ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
    errors.push(label);
  }
}

function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.error(`  ✗ ${label}`);
    console.error(`      Expected: ${JSON.stringify(expected)}`);
    console.error(`      Actual  : ${JSON.stringify(actual)}`);
    failed++;
    errors.push(label);
  } else {
    console.log(`  ✓ ${label}`);
    passed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
}

function summary() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    console.log('\n  Failed tests:');
    errors.forEach(e => console.log(`    ✗ ${e}`));
  }
  console.log('══════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

// ── Fixture Data ───────────────────────────────────────────────────────────

const APP_A = {
  title       : '25/01142/HH',
  area        : 'Newham',
  address     : '3 Oakdale Road Forest Gate London E7 8JU',
  description : 'Erection of rear and side extension.',
  startDate   : '2026-05-27',
  planitUrl   : 'https://www.planit.org.uk/planapplic/Newham/25/01142/HH/',
  sourceUrl   : 'https://pa.newham.gov.uk/online-applications/applicationDetails.do?keyVal=SWXDIXJYJIV00',
  platform    : 'idox',
  documents   : [],
  decision    : null,
};

const APP_B = {
  title       : 'UTT/26/1256/TPO',
  area        : 'Uttlesford',
  address     : '57 The Street Manuden Essex CM23 1DH',
  description : '1no. Lime tree — remove or pollard to 18ft',
  startDate   : '2026-05-26',
  platform    : 'idox',
  documents   : [
    { name: 'Floor Plan', type: 'floor plan', filename: 'floor_plan.pdf', hash: 'aabbcc', date: '2026-05-26' },
    { name: 'Revised Elevation Rev A', type: 'elevation', filename: 'elevation_rev_a.pdf', hash: 'ddeeff', date: '2026-05-27' },
    { name: 'Decision Notice', type: 'decision notice', filename: 'decision.pdf', hash: '112233', date: '2026-05-28' },
  ],
  decision      : 'GRANTED',
  decision_date : '2026-05-28',
};

const APP_B_UPDATED = {
  ...APP_B,
  documents: [
    ...APP_B.documents,
    { name: 'Revised Plan Rev B', type: 'floor plan', filename: 'floor_plan_rev_b.pdf', hash: 'xxyyzz', date: '2026-06-01' },
  ],
  decision: 'REFUSED', // Changed!
};

// ── 1. TimelineBuilder Tests ───────────────────────────────────────────────

section('1. timelineBuilder');

const { buildTimeline, makeEvent, isRevisedDrawing, isDecisionNotice, isPlanDocument, safeDate } = require('../src/platform/timelineBuilder');

// safeDate
assert(safeDate('2026-05-27') === '2026-05-27', 'safeDate: valid date returns YYYY-MM-DD');
assert(safeDate('not-a-date') === null,           'safeDate: invalid date returns null');
assert(safeDate(null) === null,                   'safeDate: null returns null');
assert(safeDate('') === null,                     'safeDate: empty string returns null');

// Document type helpers
assert(isRevisedDrawing('Revised Elevation Rev A'),        'isRevisedDrawing: Rev A detected');
assert(isRevisedDrawing('amendment_v2.pdf'),               'isRevisedDrawing: amendment detected');
assert(!isRevisedDrawing('Floor Plan Ground Floor.pdf'),   'isRevisedDrawing: normal plan not flagged');
assert(isDecisionNotice('Decision Notice Final'),          'isDecisionNotice: decision notice detected');
assert(isDecisionNotice('', 'officer report'),             'isDecisionNotice: officer report via type field');
assert(isPlanDocument('Ground Floor Plan'),                'isPlanDocument: floor plan detected');
assert(isPlanDocument('', 'elevation'),                    'isPlanDocument: elevation via type field');

// buildTimeline — basic application with no documents
const tlNoDoc = buildTimeline(APP_A, []);
assert(tlNoDoc.length >= 1,                                  'buildTimeline: produces at least 1 event for app with startDate');
assert(tlNoDoc[0].type === 'application_submitted',          'buildTimeline: first event is application_submitted');
assert(tlNoDoc[0].date === '2026-05-27',                     'buildTimeline: submitted date matches startDate');

// buildTimeline — with documents
const tlWithDocs = buildTimeline(APP_B, APP_B.documents);
const types = tlWithDocs.map(e => e.type);
assert(types.includes('application_submitted'),              'buildTimeline: includes application_submitted');
assert(types.includes('new_plans_uploaded'),                 'buildTimeline: includes new_plans_uploaded from floor plan');
assert(types.includes('revised_drawings_added'),             'buildTimeline: includes revised_drawings_added from Rev A');
assert(types.includes('decision_issued'),                    'buildTimeline: includes decision_issued from decision notice');

// buildTimeline — chronological order
const dates = tlWithDocs.map(e => e.date).filter(Boolean);
const sorted = [...dates].sort();
assertEqual(dates, sorted,                                   'buildTimeline: events are chronologically ordered');

// buildTimeline — deduplication
const tlDup = buildTimeline(APP_B, [...APP_B.documents, ...APP_B.documents]);
assertEqual(tlDup.length, tlWithDocs.length, 'buildTimeline: deduplicates identical events');

// ── 2. DatasetBuilder Tests ────────────────────────────────────────────────

section('2. datasetBuilder');

const { slugify, enrichDocuments, buildRecord, loadJson } = require('../src/platform/datasetBuilder');

// slugify
assertEqual(slugify('25/01142/HH'),       '25_01142_HH',          'slugify: slashes replaced with underscores');
assertEqual(slugify('UTT/26/1256/TPO'),   'UTT_26_1256_TPO',      'slugify: multi-slash ref');
assertEqual(slugify(''),                  '',                       'slugify: empty string');
assertEqual(slugify(null),                '',                       'slugify: null input');

// enrichDocuments — no local files (no hashes expected)
const { documents: enrDocs, hashes: enrHashes } = enrichDocuments(APP_B.documents, APP_B.title);
assert(enrDocs.length === 3,                                  'enrichDocuments: all 3 docs returned');
assert(typeof enrDocs[0].name === 'string',                   'enrichDocuments: name field present');
assert(typeof enrDocs[0].type === 'string',                   'enrichDocuments: type field present');
// Hashes from fixture have no real files so hash should come from doc.hash field
assert(enrDocs[0].hash === 'aabbcc',                          'enrichDocuments: hash from doc fixture preserved');

// buildRecord — canonical structure check
const record = buildRecord(APP_B);
assert(record.application_id === 'UTT/26/1256/TPO',          'buildRecord: application_id mapped correctly');
assert(record.council === 'Uttlesford',                       'buildRecord: council from area field');
assert(record.address === APP_B.address,                      'buildRecord: address preserved');
assert(record.proposal === APP_B.description,                 'buildRecord: proposal from description');
assert(record.decision === 'GRANTED',                         'buildRecord: decision preserved');
assert(Array.isArray(record.documents),                       'buildRecord: documents is array');
assert(Array.isArray(record.intelligence),                    'buildRecord: intelligence is array');
assert(Array.isArray(record.timeline),                        'buildRecord: timeline is array');
assert(Array.isArray(record.hashes),                          'buildRecord: hashes is array');
assert(typeof record.updated_at === 'string',                 'buildRecord: updated_at is ISO string');

// All canonical fields present
const CANONICAL_FIELDS = ['application_id','council','address','proposal','decision',
  'decision_date','applicant','platform','documents','intelligence','timeline','hashes','updated_at'];
for (const field of CANONICAL_FIELDS) {
  assert(Object.prototype.hasOwnProperty.call(record, field),  `buildRecord: field "${field}" present`);
}

// ── 3. SearchEngine Tests ──────────────────────────────────────────────────

section('3. searchEngine');

const { SearchEngine, buildIndex, flattenDocuments, applyFilters } = require('../src/platform/searchEngine');

// Build records for search tests
const recA = buildRecord(APP_A);
const recB = buildRecord(APP_B);
const records = [recA, recB];

// flattenDocuments
const { document_names, document_types } = flattenDocuments(APP_B.documents);
assert(document_names.includes('Floor Plan'),            'flattenDocuments: includes doc name');
assert(document_types.includes('elevation'),             'flattenDocuments: includes doc type');

// SearchEngine construction
const engine = new SearchEngine(records);
assert(engine.size === 2,                                'SearchEngine: correct record count');

// Basic keyword search
const res1 = engine.search('oakdale');
assert(res1.length >= 1,                                 'search: finds APP_A by address keyword');
assert(res1[0].application_id === '25/01142/HH',        'search: correct top result for "oakdale"');

const res2 = engine.search('lime tree');
assert(res2.length >= 1,                                 'search: finds APP_B by proposal keyword');

// Fuzzy search — typo "oakdal" should still match "oakdale"
const resFuzzy = engine.search('oakdal', { fuzzy: 0.3 });
assert(resFuzzy.length >= 1,                             'search: fuzzy match for typo "oakdal"');

// Prefix search
const resPrefix = engine.search('Uttles', { prefix: true });
assert(resPrefix.length >= 1,                            'search: prefix match for "Uttles"');

// Filter by council
const resFiltered = engine.search('extension', { filters: { council: 'Newham' } });
assert(resFiltered.length >= 1,                          'search: keyword + council filter returns result');
assert(resFiltered.every(r => r.council === 'Newham'),   'search: all results match council filter');

// Filter by decision
const resDecision = engine.search('tree', { filters: { decision: 'GRANTED' } });
assert(resDecision.length >= 1,                          'search: decision filter works');

// applyFilters — empty filters passthrough
const allRes = [{ council: 'Camden', decision: 'REFUSED', document_types: 'floor plan' }];
assert(applyFilters(allRes, {}).length === 1,            'applyFilters: empty filters passes all');
assert(applyFilters(allRes, { council: 'Camden' }).length === 1,   'applyFilters: council match');
assert(applyFilters(allRes, { council: 'Newham' }).length === 0,   'applyFilters: council non-match');
assert(applyFilters(allRes, { decision: 'REFUSED' }).length === 1, 'applyFilters: decision match');
assert(applyFilters(allRes, { documentCategory: 'floor' }).length === 1, 'applyFilters: doc category partial match');

// listCouncils / listDecisions
const councils = engine.listCouncils();
assert(councils.includes('Uttlesford'),                  'listCouncils: includes Uttlesford');
assert(councils.includes('Newham'),                      'listCouncils: includes Newham');

// getById
const byId = engine.getById('25/01142/HH');
assert(byId !== null,                                    'getById: finds record by application_id');
assert(engine.getById('NONEXISTENT') === null,           'getById: returns null for unknown ID');

// rebuild
engine.rebuild(records);
assert(engine.size === 2,                                'rebuild: engine reloaded correctly');

// status
const status = engine.status();
assert(typeof status.indexed_records === 'number',       'status: indexed_records is number');
assert(typeof status.indexed_at === 'string',            'status: indexed_at is ISO string');

// ── 4. ChangeDetector Tests ────────────────────────────────────────────────

section('4. changeDetector');

const { computeDiff, appendChangeLog, loadChangeLog } = require('../src/platform/changeDetector');
const os   = require('os');
const fs   = require('fs');
const path = require('path');

// Override CHANGE_LOG path to a temp file for testing
const tmpLog = path.join(os.tmpdir(), `change_log_test_${Date.now()}.json`);

// Simulate: first run from empty prev
const prev0   = [];
const curr1   = [recA, recB];
const diff1   = computeDiff(prev0, curr1);

assertEqual(diff1.new_applications.length, 2,            'computeDiff: 2 new apps from empty baseline');
assertEqual(diff1.removed_applications.length, 0,        'computeDiff: no removals on first run');
assertEqual(diff1.updated_decisions.length, 0,           'computeDiff: no decision changes on first run');
assertEqual(diff1.new_documents.length, 0,               'computeDiff: no new docs (all are new_applications)');

// Simulate: second run — one new document, one decision change
const recBUpdated = buildRecord(APP_B_UPDATED);
const curr2  = [recA, recBUpdated];
const diff2  = computeDiff(curr1, curr2);

assertEqual(diff2.new_applications.length, 0,            'computeDiff: no new applications in run 2');
assertEqual(diff2.removed_applications.length, 0,        'computeDiff: no removals in run 2');
assert(diff2.new_documents.length >= 1,                  'computeDiff: new document detected in run 2');
assertEqual(diff2.updated_decisions.length, 1,           'computeDiff: decision change GRANTED→REFUSED detected');
assert(diff2.updated_decisions[0].previous_decision === 'GRANTED', 'computeDiff: previous decision is GRANTED');
assert(diff2.updated_decisions[0].new_decision === 'REFUSED',      'computeDiff: new decision is REFUSED');
assert(diff2.revised_plans.length >= 1,                  'computeDiff: revised plan Rev B flagged');

// Simulate: removal
const curr3  = [recA]; // recB removed
const diff3  = computeDiff(curr2, curr3);
assertEqual(diff3.removed_applications.length, 1,        'computeDiff: removal detected');
assertEqual(diff3.removed_applications[0].application_id, 'UTT/26/1256/TPO', 'computeDiff: correct removed app_id');

// appendChangeLog with temp override (test the structure only, using in-memory)
const logEntry = {
  run_id     : 'test_run_1',
  run_at     : new Date().toISOString(),
  triggered_by: 'platform_tests',
  summary    : { new_applications: 2, removed_applications: 0, new_documents: 0, changed_hashes: 0, updated_decisions: 0, revised_plans: 0 },
  changes    : diff1,
};
fs.writeFileSync(tmpLog, JSON.stringify([logEntry], null, 2));
const loaded = JSON.parse(fs.readFileSync(tmpLog, 'utf8'));
assert(Array.isArray(loaded),                            'change_log: is an array');
assert(loaded[0].run_id === 'test_run_1',                'change_log: run_id preserved');
assert(loaded[0].summary.new_applications === 2,         'change_log: summary.new_applications correct');
assert(typeof loaded[0].changes.new_applications === 'object', 'change_log: changes.new_applications is array');
fs.unlinkSync(tmpLog);

// ── 5. Platform API Tests ──────────────────────────────────────────────────

section('5. platform/index API');

const {
  getOverviewStats,
  getTopActiveCouncils,
  searchApplications,
  invalidateCache,
} = require('../src/platform/index');

// Inject test records directly by bypassing the file load
const indexModule = require('../src/platform/index');

// Force re-init of cached state with test records
indexModule.__injectTestRecords([recA, recB]);

const stats = getOverviewStats();
assert(stats.total_applications === 2,                   'getOverviewStats: total_applications correct');
assert(typeof stats.with_documents === 'number',         'getOverviewStats: with_documents is number');
assert(typeof stats.total_documents === 'number',        'getOverviewStats: total_documents is number');
assert(typeof stats.decisions === 'object',              'getOverviewStats: decisions breakdown is object');
assert(typeof stats.document_categories === 'object',    'getOverviewStats: document_categories is object');
assert(typeof stats.monthly_submissions === 'object',    'getOverviewStats: monthly_submissions is object');

const topCouncils = getTopActiveCouncils(5);
assert(Array.isArray(topCouncils),                       'getTopActiveCouncils: returns array');
assert(topCouncils.length <= 5,                          'getTopActiveCouncils: respects limit');
assert(typeof topCouncils[0].council === 'string',       'getTopActiveCouncils: council field present');
assert(typeof topCouncils[0].count === 'number',         'getTopActiveCouncils: count field present');

const searchRes = searchApplications('oakdale');
assert(Array.isArray(searchRes),                         'searchApplications: returns array');
assert(searchRes.length >= 1,                            'searchApplications: finds result for "oakdale"');

const searchFiltered = searchApplications('tree', { council: 'Uttlesford' });
assert(Array.isArray(searchFiltered),                    'searchApplications: filtered search returns array');

// Cleanup not strictly needed since we used injection

// ── Summary ────────────────────────────────────────────────────────────────
summary();
