'use strict';

/**
 * searchEngine.js
 * MiniSearch-powered full-text search over the master dataset.
 *
 * Features:
 *  - Keyword search across application_id, council, address, proposal, applicant, document names/types
 *  - Fuzzy matching (Levenshtein distance)
 *  - Prefix matching
 *  - Filter by: council, decision, document category
 *  - Returns ranked results with match info
 */

const MiniSearch = require('minisearch');
const { loadMasterDataset } = require('./datasetBuilder');

// ── Index Configuration ────────────────────────────────────────────────────

const SEARCH_FIELDS = [
  'application_id',
  'council',
  'address',
  'proposal',
  'applicant',
  'decision',
  'document_names',
  'document_types',
];

const STORE_FIELDS = [
  'application_id',
  'council',
  'address',
  'proposal',
  'applicant',
  'decision',
  'decision_date',
  'platform',
  'planit_url',
  'document_count',
];

// ── Builder ────────────────────────────────────────────────────────────────

/**
 * Flatten document names and types from an application record into
 * searchable string fields.
 * @param {object[]} documents
 * @returns {{ document_names: string, document_types: string }}
 */
function flattenDocuments(documents = []) {
  const names = documents.map(d => d.name || '').filter(Boolean).join(' ');
  const types = documents.map(d => d.type || '').filter(Boolean).join(' ');
  return { document_names: names, document_types: types };
}

/**
 * Build a MiniSearch index from a records array.
 * @param {object[]} records  Array of canonical master_dataset records
 * @returns {MiniSearch}
 */
function buildIndex(records) {
  const ms = new MiniSearch({
    fields: SEARCH_FIELDS,
    storeFields: STORE_FIELDS,
    idField: 'application_id',
    searchOptions: {
      boost: { application_id: 3, address: 2, proposal: 2 },
      fuzzy: 0.2,
      prefix: true,
    },
    processTerm: term => term.toLowerCase().trim(),
  });

  const docs = records.map((r, i) => {
    const { document_names, document_types } = flattenDocuments(r.documents);
    return {
      // Stored fields
      application_id : r.application_id || `unknown_${i}`,
      council        : r.council        || '',
      address        : r.address        || '',
      proposal       : r.proposal       || '',
      applicant      : r.applicant      || '',
      decision       : r.decision       || '',
      decision_date  : r.decision_date  || '',
      platform       : r.platform       || '',
      planit_url     : r.planit_url     || '',
      document_count : (r.documents || []).length,
      // Search-only fields
      document_names,
      document_types,
    };
  });

  ms.addAll(docs);
  return ms;
}

// ── Search API ─────────────────────────────────────────────────────────────

/**
 * Apply post-search filters to results.
 * @param {object[]} results   MiniSearch result objects
 * @param {object}  filters
 * @param {string}  [filters.council]          Exact or partial council name match
 * @param {string}  [filters.decision]         Exact or partial decision match
 * @param {string}  [filters.documentCategory] Partial match against document_types
 * @returns {object[]}
 */
function applyFilters(results, filters = {}) {
  return results.filter(r => {
    if (filters.council) {
      if (!r.council || !r.council.toLowerCase().includes(filters.council.toLowerCase())) {
        return false;
      }
    }
    if (filters.decision) {
      if (!r.decision || !r.decision.toLowerCase().includes(filters.decision.toLowerCase())) {
        return false;
      }
    }
    if (filters.documentCategory) {
      const cat = filters.documentCategory.toLowerCase();
      if (!r.document_types || !r.document_types.toLowerCase().includes(cat)) {
        return false;
      }
    }
    return true;
  });
}

// ── Main Class ─────────────────────────────────────────────────────────────

class SearchEngine {
  /**
   * @param {object[]} [records]  Pre-loaded records. If omitted, loads from master_dataset.json.
   */
  constructor(records = null) {
    this._records = records || loadMasterDataset();
    this._index   = buildIndex(this._records);
    this._indexedAt = new Date().toISOString();
  }

  /**
   * Total number of indexed documents.
   * @returns {number}
   */
  get size() {
    return this._records.length;
  }

  /**
   * Perform a full-text search with optional filters.
   *
   * @param {string} query                    Keyword query string
   * @param {object} [options]
   * @param {object} [options.filters]        { council, decision, documentCategory }
   * @param {number} [options.limit]          Max results to return (default: 20)
   * @param {number} [options.fuzzy]          Fuzzy distance override (0–1, default: 0.2)
   * @param {boolean} [options.prefix]        Enable prefix matching (default: true)
   * @returns {object[]}  Ranked search results
   */
  search(query, options = {}) {
    if (!query || !query.trim()) return [];

    const { filters = {}, limit = 20, fuzzy = 0.2, prefix = true } = options;

    const rawResults = this._index.search(query, { fuzzy, prefix });
    const filtered   = applyFilters(rawResults, filters);
    return filtered.slice(0, limit);
  }

  /**
   * List all unique councils in the index.
   * @returns {string[]}
   */
  listCouncils() {
    const councils = new Set(this._records.map(r => r.council).filter(Boolean));
    return [...councils].sort();
  }

  /**
   * List all unique decisions in the index.
   * @returns {string[]}
   */
  listDecisions() {
    const decisions = new Set(this._records.map(r => r.decision).filter(Boolean));
    return [...decisions].sort();
  }

  /**
   * Get the full canonical record for a given application_id.
   * @param {string} applicationId
   * @returns {object|null}
   */
  getById(applicationId) {
    return this._records.find(r => r.application_id === applicationId) || null;
  }

  /**
   * Rebuild the index from fresh data.
   * @param {object[]} [records]
   */
  rebuild(records = null) {
    this._records = records || loadMasterDataset();
    this._index   = buildIndex(this._records);
    this._indexedAt = new Date().toISOString();
  }

  /**
   * Return a status summary of the search engine.
   * @returns {object}
   */
  status() {
    return {
      indexed_records : this.size,
      indexed_at      : this._indexedAt,
      councils        : this.listCouncils().length,
    };
  }
}

module.exports = { SearchEngine, buildIndex, flattenDocuments, applyFilters };
