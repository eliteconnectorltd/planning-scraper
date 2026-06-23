'use strict';

/**
 * changeDetector.js
 * Diffs two master_dataset snapshots to detect changes between scraper runs.
 *
 * Tracks:
 *  - new_applications        : Added applications not in previous run
 *  - removed_applications    : Applications present in previous run but not new run
 *  - new_documents           : New documents added to existing applications
 *  - changed_hashes          : Documents whose SHA-256 hash changed (updated PDFs)
 *  - updated_decisions       : Decision field changed (e.g. null → GRANTED)
 *  - revised_plans           : New documents whose names suggest revisions
 *
 * Output: output/change_log.json  (append-only list of run diffs)
 */

const fs   = require('fs');
const path = require('path');
const { loadMasterDataset, loadJson, MASTER_FILE } = require('./datasetBuilder');
const { isRevisedDrawing } = require('./timelineBuilder');
const changeLogRepository = require('../db/repositories/changeLogRepository');

// ── Paths ──────────────────────────────────────────────────────────────────
const ROOT           = path.resolve(__dirname, '../../');
const OUTPUT_DIR     = path.join(ROOT, 'output');
const CHANGE_LOG     = path.join(OUTPUT_DIR, 'change_log.json');
const PREV_SNAPSHOT  = path.join(OUTPUT_DIR, 'prev_master_dataset.json');

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a lookup map from an array of records by application_id.
 * @param {object[]} records
 * @returns {Map<string, object>}
 */
function toMap(records) {
  const m = new Map();
  for (const r of records) {
    if (r.application_id) m.set(r.application_id, r);
  }
  return m;
}

/**
 * Build a lookup map of document hashes keyed by filename.
 * @param {object[]} documents
 * @returns {Map<string, string>}   filename → hash
 */
function docHashMap(documents = []) {
  const m = new Map();
  for (const d of documents) {
    if (d.filename && d.hash) m.set(d.filename, d.hash);
  }
  return m;
}

/**
 * Build a Set of document filenames for a record.
 * @param {object[]} documents
 * @returns {Set<string>}
 */
function docNameSet(documents = []) {
  return new Set(documents.map(d => d.filename || d.name).filter(Boolean));
}

// ── Diff Engine ────────────────────────────────────────────────────────────

/**
 * Compute a full diff between two master dataset snapshots.
 *
 * @param {object[]} prevRecords   Previous snapshot (may be empty array for first run)
 * @param {object[]} newRecords    Current snapshot
 * @returns {object}               Structured diff object
 */
function computeDiff(prevRecords, newRecords) {
  const prevMap = toMap(prevRecords);
  const newMap  = toMap(newRecords);

  const new_applications     = [];
  const removed_applications = [];
  const new_documents        = [];
  const changed_hashes       = [];
  const updated_decisions    = [];
  const revised_plans        = [];

  // ── New and removed applications
  for (const id of newMap.keys()) {
    if (!prevMap.has(id)) {
      new_applications.push({ application_id: id, council: newMap.get(id).council });
    }
  }
  for (const id of prevMap.keys()) {
    if (!newMap.has(id)) {
      removed_applications.push({ application_id: id, council: prevMap.get(id).council });
    }
  }

  // ── Per-application document and decision diffs
  for (const [id, newRec] of newMap) {
    const prevRec = prevMap.get(id);
    if (!prevRec) continue; // handled above as new_application

    // Decision change
    if (newRec.decision !== prevRec.decision) {
      updated_decisions.push({
        application_id  : id,
        previous_decision: prevRec.decision,
        new_decision    : newRec.decision,
        decision_date   : newRec.decision_date,
      });
    }

    // Document-level diffs
    const prevNames   = docNameSet(prevRec.documents);
    const prevHashes  = docHashMap(prevRec.documents);
    const newHashes   = docHashMap(newRec.documents);

    for (const doc of (newRec.documents || [])) {
      const fname = doc.filename || doc.name;
      if (!fname) continue;

      // New document not in previous run
      if (!prevNames.has(fname)) {
        new_documents.push({
          application_id : id,
          filename       : fname,
          type           : doc.type || '',
          url            : doc.url  || '',
        });

        // Also flag if it looks like a revision
        if (isRevisedDrawing(fname, doc.type)) {
          revised_plans.push({
            application_id : id,
            filename       : fname,
            type           : doc.type || '',
          });
        }
      }

      // Changed hash for an existing document
      if (prevHashes.has(fname) && doc.hash && prevHashes.get(fname) !== doc.hash) {
        changed_hashes.push({
          application_id : id,
          filename       : fname,
          previous_hash  : prevHashes.get(fname),
          new_hash       : doc.hash,
        });
      }
    }
  }

  return {
    new_applications,
    removed_applications,
    new_documents,
    changed_hashes,
    updated_decisions,
    revised_plans,
  };
}

// ── Change Log ─────────────────────────────────────────────────────────────

/**
 * Load the existing change log (or return empty array).
 * @returns {object[]}
 */
function loadChangeLog() {
  return loadJson(CHANGE_LOG) || [];
}

/**
 * Append a run entry to change_log.json.
 * @param {object} diffResult  Output of computeDiff()
 * @param {object} [meta]      Optional metadata (run_id, triggered_by, etc.)
 * @returns {object}           The log entry that was appended
 */
function appendChangeLog(diffResult, meta = {}) {
  const log    = loadChangeLog();
  const entry  = {
    run_id        : meta.run_id || `run_${Date.now()}`,
    run_at        : new Date().toISOString(),
    triggered_by  : meta.triggered_by || 'platform',
    summary: {
      new_applications     : diffResult.new_applications.length,
      removed_applications : diffResult.removed_applications.length,
      new_documents        : diffResult.new_documents.length,
      changed_hashes       : diffResult.changed_hashes.length,
      updated_decisions    : diffResult.updated_decisions.length,
      revised_plans        : diffResult.revised_plans.length,
    },
    changes: diffResult,
  };
  log.push(entry);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(CHANGE_LOG, JSON.stringify(log, null, 2), 'utf8');

  const changesForDb = [];
  for (const item of diffResult.new_applications) {
    changesForDb.push({ type: 'new_application', application_id: null, current: item });
  }
  for (const item of diffResult.removed_applications) {
    changesForDb.push({ type: 'removed_application', application_id: null, previous: item });
  }
  for (const item of diffResult.new_documents) {
    changesForDb.push({ type: 'new_document', application_id: null, current: item });
  }
  for (const item of diffResult.changed_hashes) {
    changesForDb.push({
      type: 'changed_hash',
      application_id: null,
      previous: { hash: item.previous_hash, filename: item.filename, application_id: item.application_id },
      current: { hash: item.new_hash, filename: item.filename, application_id: item.application_id },
    });
  }
  for (const item of diffResult.updated_decisions) {
    changesForDb.push({
      type: 'updated_decision',
      application_id: null,
      previous: { decision: item.previous_decision, application_id: item.application_id },
      current: { decision: item.new_decision, decision_date: item.decision_date, application_id: item.application_id },
    });
  }
  changeLogRepository.insertChanges(changesForDb).catch(err => {
    console.warn(`  [warn] Supabase change log persistence failed: ${err.message}`);
  });

  return entry;
}

// ── Main Function ──────────────────────────────────────────────────────────

/**
 * Run change detection:
 *  1. Load previous snapshot (prev_master_dataset.json, if exists)
 *  2. Load current master_dataset.json
 *  3. Compute diff
 *  4. Append to change_log.json
 *  5. Rotate: save current as prev_master_dataset.json
 *
 * @param {object} [options]
 * @param {object[]} [options.prevRecords]   Override prev snapshot (for testing)
 * @param {object[]} [options.newRecords]    Override new snapshot (for testing)
 * @param {object}  [options.meta]           Metadata to embed in log entry
 * @returns {object}  { diff, logEntry }
 */
function detectChanges(options = {}) {
  const prevRecords = options.prevRecords !== undefined
    ? options.prevRecords
    : (loadJson(PREV_SNAPSHOT) || []);

  const newRecords = options.newRecords !== undefined
    ? options.newRecords
    : loadMasterDataset();

  const diff     = computeDiff(prevRecords, newRecords);
  const logEntry = appendChangeLog(diff, options.meta || {});

  // Rotate snapshot: current becomes previous for next run
  if (options.newRecords === undefined) {
    const current = loadMasterDataset();
    fs.writeFileSync(PREV_SNAPSHOT, JSON.stringify(current, null, 2), 'utf8');
  }

  return { diff, logEntry };
}

/**
 * Print a human-readable summary of a diff.
 * @param {object} diff
 */
function printDiffSummary(diff) {
  console.log('\n── Change Detection Summary ──────────────────────────');
  console.log(`  New applications     : ${diff.new_applications.length}`);
  console.log(`  Removed applications : ${diff.removed_applications.length}`);
  console.log(`  New documents        : ${diff.new_documents.length}`);
  console.log(`  Changed hashes       : ${diff.changed_hashes.length}`);
  console.log(`  Updated decisions    : ${diff.updated_decisions.length}`);
  console.log(`  Revised plans        : ${diff.revised_plans.length}`);
  console.log('─────────────────────────────────────────────────────\n');
}

module.exports = {
  detectChanges,
  computeDiff,
  appendChangeLog,
  loadChangeLog,
  printDiffSummary,
  CHANGE_LOG,
  PREV_SNAPSHOT,
};
