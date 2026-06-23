'use strict';

/**
 * datasetBuilder.js
 * Compiles a unified canonical master dataset from:
 *  - output/results.json         (scraper application records)
 *  - output/downloads/           (downloaded file manifests per application)
 *  - output/intelligence/        (document intelligence payloads, if present)
 *
 * Produces: output/master_dataset.json
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildTimeline } = require('./timelineBuilder');

// ── Paths ──────────────────────────────────────────────────────────────────
const ROOT         = path.resolve(__dirname, '../../');
const OUTPUT_DIR   = path.join(ROOT, 'output');
const RESULTS_FILE = path.join(OUTPUT_DIR, 'results.json');
const DOWNLOADS_DIR = path.join(OUTPUT_DIR, 'downloads');
const DOWNLOAD_MANIFEST_FILE = path.join(OUTPUT_DIR, 'download_manifest.json');
const INTEL_DIR    = path.join(OUTPUT_DIR, 'intelligence');
const MASTER_FILE  = path.join(OUTPUT_DIR, 'master_dataset.json');

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 of a file on disk. Returns null if file does not exist.
 * @param {string} filePath
 * @returns {string|null}
 */
function hashFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Load and parse a JSON file. Returns null on error.
 * @param {string} filePath
 * @returns {any|null}
 */
function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Slugify an application title for use as a directory/file name.
 * e.g. "25/01142/HH" → "25_01142_HH"
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
  return (title || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Load intelligence data for an application, if available.
 * Looks for output/intelligence/<slug>.json or output/intelligence/<slug>/index.json
 * @param {string} appId
 * @returns {object|null}
 */
function loadIntelligence(appId) {
  if (!fs.existsSync(INTEL_DIR)) return null;
  const slug = slugify(appId);
  const candidates = [
    path.join(INTEL_DIR, `${slug}.json`),
    path.join(INTEL_DIR, slug, 'index.json'),
    path.join(INTEL_DIR, `${appId}.json`),
  ];
  for (const c of candidates) {
    const data = loadJson(c);
    if (data) return data;
  }
  return null;
}

/**
 * Load download manifest for an application.
 * Looks for output/downloads/<slug>/manifest.json or output/downloads/<slug>.json
 * @param {string} appId
 * @returns {object[]|null}
 */
function loadManifest(appId) {
  const slug = slugify(appId);
  const globalManifest = loadJson(DOWNLOAD_MANIFEST_FILE);
  if (globalManifest && Array.isArray(globalManifest.files)) {
    const matching = globalManifest.files.filter(f => f.application === appId);
    if (matching.length > 0) return matching;
  }

  if (!fs.existsSync(DOWNLOADS_DIR)) return null;

  const candidates = [
    path.join(DOWNLOADS_DIR, slug, 'manifest.json'),
    path.join(DOWNLOADS_DIR, `${slug}.json`),
    path.join(DOWNLOADS_DIR, `${appId}`, 'manifest.json'),
  ];
  for (const c of candidates) {
    const data = loadJson(c);
    if (data) return Array.isArray(data) ? data : (data.documents || data.files || []);
  }
  return null;
}

/**
 * Enrich document objects with computed hashes and normalised fields.
 * @param {object[]} rawDocs
 * @param {string} appId
 * @returns {{ documents: object[], hashes: object[] }}
 */
function enrichDocuments(rawDocs, appId) {
  const documents = [];
  const hashes    = [];
  const slug      = slugify(appId);

  for (const doc of rawDocs) {
    const name     = doc.name || doc.title || doc.originalName || doc.normalizedName || doc.filename || '';
    const type     = doc.type || doc.category || doc.documentType || doc.mimeType || '';
    const url      = doc.url || doc.href || doc.sourceUrl || doc.finalUrl || '';
    const filename = doc.filename || doc.savedAs || doc.normalizedName || path.basename(url) || '';
    const localPath = doc.localPath || doc.path ||
      path.join(DOWNLOADS_DIR, slug, filename);

    const hash = hashFile(localPath);

    const enriched = {
      name,
      type,
      url,
      filename,
      local_path: localPath,
      hash: hash || doc.hash || null,
      date: doc.date || doc.received_date || null,
    };
    documents.push(enriched);

    if (hash) {
      hashes.push({ filename, hash, computed_at: new Date().toISOString() });
    }
  }

  return { documents, hashes };
}

function mergeDocumentMetadata(manifestDocs, embeddedDocs) {
  if (!Array.isArray(manifestDocs) || !Array.isArray(embeddedDocs)) {
    return manifestDocs || embeddedDocs || [];
  }

  return manifestDocs.map(manifestDoc => {
    const manifestUrl = manifestDoc.sourceUrl || manifestDoc.finalUrl || manifestDoc.url;
    const match = embeddedDocs.find(doc => (doc.url || doc.sourceUrl || doc.finalUrl) === manifestUrl);
    return match ? { ...manifestDoc, ...match, localPath: manifestDoc.localPath } : manifestDoc;
  });
}

/**
 * Build the canonical record for one application.
 * @param {object} app       Raw record from results.json
 * @returns {object}         Canonical master_dataset record
 */
function buildRecord(app) {
  const appId = app.title || app.application_id || app.ref || '';

  // Load supplementary data
  const intelligence = loadIntelligence(appId);
  const manifestDocs = loadManifest(appId);

  // Merge documents: prefer manifest (richer) over embedded documents array
  const rawDocs = mergeDocumentMetadata(manifestDocs, app.documents);
  const { documents, hashes } = enrichDocuments(rawDocs, appId);

  // Build timeline
  const timeline = buildTimeline(app, rawDocs, intelligence);

  // Extract intelligence fields
  const intelFields = intelligence ? {
    decision      : intelligence.decision      || null,
    decision_date : intelligence.decision_date || null,
    applicant     : intelligence.applicant     || null,
  } : {};

  return {
    application_id : appId,
    council        : app.area        || app.council     || null,
    address        : app.address     || null,
    proposal       : app.description || app.proposal    || null,
    decision       : app.decision    || intelFields.decision      || null,
    decision_date  : app.decision_date || intelFields.decision_date || null,
    applicant      : app.applicant   || intelFields.applicant      || null,
    platform       : app.platform    || null,
    planit_url     : app.planitUrl   || null,
    source_url     : app.sourceUrl   || null,
    documents,
    intelligence   : intelligence ? [intelligence] : [],
    timeline,
    hashes,
    updated_at     : new Date().toISOString(),
  };
}

/**
 * Main build function — compile and write master_dataset.json.
 * @returns {{ records: object[], written: string }}
 */
function buildDataset() {
  if (!fs.existsSync(RESULTS_FILE)) {
    throw new Error(`results.json not found at: ${RESULTS_FILE}`);
  }

  const raw = loadJson(RESULTS_FILE);
  if (!Array.isArray(raw)) {
    throw new Error('results.json must be a JSON array of applications.');
  }

  const records = raw.map((app, i) => {
    try {
      return buildRecord(app);
    } catch (err) {
      console.warn(`  [warn] Failed to build record #${i}: ${err.message}`);
      return null;
    }
  }).filter(Boolean);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(MASTER_FILE, JSON.stringify(records, null, 2), 'utf8');

  return { records, written: MASTER_FILE };
}

/**
 * Load existing master_dataset.json (or return empty array).
 * @returns {object[]}
 */
function loadMasterDataset() {
  return loadJson(MASTER_FILE) || [];
}

module.exports = {
  buildDataset,
  loadMasterDataset,
  buildRecord,
  enrichDocuments,
  hashFile,
  loadJson,
  slugify,
  MASTER_FILE,
  RESULTS_FILE,
};
