'use strict';

/**
 * src/platform/index.js
 * Orchestrator for the Searchable Planning Intelligence Platform.
 *
 * When run directly (node src/platform/index.js):
 *   1. Builds / refreshes master_dataset.json from results.json + manifests + intelligence
 *   2. Runs change detection and appends to change_log.json
 *   3. Prints a dashboard summary to stdout
 *
 * Also exports a programmatic API:
 *   getOverviewStats()
 *   getTopActiveCouncils(limit)
 *   searchApplications(query, filters, options)
 *   getChangeLog()
 */

const path = require('path');
const datasetBuilder = require('./datasetBuilder');
const { detectChanges, printDiffSummary, loadChangeLog } = require('./changeDetector');
const { SearchEngine } = require('./searchEngine');

// ── Internal state (lazy-loaded) ───────────────────────────────────────────
let _engine   = null;
let _records  = null;

function ensureLoaded() {
  if (!_records) {
    _records = datasetBuilder.loadMasterDataset();
  }
  if (!_engine) {
    _engine = new SearchEngine(_records);
  }
}

// ── Dashboard API ──────────────────────────────────────────────────────────

/**
 * Compute overview statistics across the entire dataset.
 * @returns {object}
 */
function getOverviewStats() {
  ensureLoaded();

  const total      = _records.length;
  const withDocs   = _records.filter(r => r.documents && r.documents.length > 0).length;
  const totalDocs  = _records.reduce((n, r) => n + (r.documents || []).length, 0);

  // Decision breakdown
  const decisions  = {};
  for (const r of _records) {
    const d = r.decision || 'PENDING';
    decisions[d] = (decisions[d] || 0) + 1;
  }

  // Monthly breakdown by submission date (from timeline application_submitted events)
  const monthly = {};
  for (const r of _records) {
    const submitted = (r.timeline || []).find(e => e.type === 'application_submitted');
    if (submitted && submitted.date) {
      const month = submitted.date.slice(0, 7); // YYYY-MM
      monthly[month] = (monthly[month] || 0) + 1;
    }
  }

  // Category breakdown across all document types
  const categories = {};
  for (const r of _records) {
    for (const doc of (r.documents || [])) {
      const t = doc.type || 'Unknown';
      categories[t] = (categories[t] || 0) + 1;
    }
  }

  return {
    total_applications : total,
    with_documents     : withDocs,
    total_documents    : totalDocs,
    decisions,
    monthly_submissions: monthly,
    document_categories: categories,
  };
}

/**
 * Return the most active councils by application count.
 * @param {number} [limit=10]
 * @returns {Array<{council: string, count: number}>}
 */
function getTopActiveCouncils(limit = 10) {
  ensureLoaded();
  const counts = {};
  for (const r of _records) {
    const c = r.council || 'Unknown';
    counts[c] = (counts[c] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([council, count]) => ({ council, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Search applications using the MiniSearch engine.
 * @param {string} query
 * @param {object} [filters]   { council, decision, documentCategory }
 * @param {object} [options]   { limit, fuzzy, prefix }
 * @returns {object[]}
 */
function searchApplications(query, filters = {}, options = {}) {
  ensureLoaded();
  return _engine.search(query, { filters, ...options });
}

/**
 * Return the full change log history.
 * @returns {object[]}
 */
function getChangeLog() {
  return loadChangeLog();
}

/**
 * Get a single application record by ID.
 * @param {string} applicationId
 * @returns {object|null}
 */
function getApplicationById(applicationId) {
  ensureLoaded();
  return _engine.getById(applicationId);
}

/**
 * Invalidate the in-memory cache so the next call reloads from disk.
 */
function invalidateCache() {
  _engine  = null;
  _records = null;
}

/**
 * Dependency injection for testing.
 */
function __injectTestRecords(records) {
  _records = records;
  _engine = new SearchEngine(records);
}

// ── Orchestration (full pipeline run) ─────────────────────────────────────

/**
 * Run the full platform pipeline:
 *  1. Build master_dataset.json
 *  2. Detect changes vs previous snapshot
 *  3. Load the engine from fresh data
 *  4. Print summary
 *
 * NOTE (architecture): this is the LEGACY disk/JSON pipeline. For the Idox path,
 * Supabase is the real datastore — `npm start` persists applications, documents,
 * and Storage files directly to Supabase and never calls this. This builder reads
 * output/results.json (+ optional output/downloads & output/intelligence) and is
 * retained only for offline/JSON-mode use and the workers/jobs folder. It is NOT
 * part of the Supabase-first flow and is intentionally not run from `npm start`.
 *
 * @returns {object} { stats, diff, changeLogEntry }
 */
async function runPlatform() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Planning Intelligence Platform — Phase 7');
  console.log('══════════════════════════════════════════════════════\n');

  // Step 1: Build unified dataset
  console.log('► Step 1: Building master dataset…');
  const { records, written } = datasetBuilder.buildDataset();
  console.log(`  ✓ Compiled ${records.length} applications → ${written}`);

  // Step 2: Change detection
  console.log('\n► Step 2: Detecting changes…');
  const { diff, logEntry } = detectChanges({ meta: { triggered_by: 'platform_run' } });
  printDiffSummary(diff);

  invalidateCache();
  ensureLoaded();
  const engineStatus = _engine.status();
  console.log(`► Step 3: Search index ready — ${engineStatus.indexed_records} records, ${engineStatus.councils} councils`);

  // Step 4: Overview stats
  const stats = getOverviewStats();
  console.log('\n► Step 4: Dataset Overview');
  console.log(`  Total applications : ${stats.total_applications}`);
  console.log(`  With documents     : ${stats.with_documents}`);
  console.log(`  Total documents    : ${stats.total_documents}`);
  console.log(`  Decisions          : ${JSON.stringify(stats.decisions)}`);
  console.log('\n  Top councils:');
  const topCouncils = getTopActiveCouncils(5);
  for (const { council, count } of topCouncils) {
    console.log(`    ${council.padEnd(30)} ${count} application(s)`);
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Platform run complete.');
  console.log('══════════════════════════════════════════════════════\n');

  return { stats, diff, changeLogEntry: logEntry };
}

// ── CLI Entry Point ────────────────────────────────────────────────────────

if (require.main === module) {
  runPlatform().catch(err => {
    console.error('Platform run failed:', err.message);
    process.exit(1);
  });
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  runPlatform,
  getOverviewStats,
  getTopActiveCouncils,
  searchApplications,
  getChangeLog,
  getApplicationById,
  invalidateCache,
  __injectTestRecords,
};
