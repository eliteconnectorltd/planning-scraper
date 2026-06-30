'use strict';

const { executeWithRetry, getClientOrNull, normalizePage } = require('./baseRepository');
const applicationsRepository = require('./applicationsRepository');

function confidenceToScore(confidence) {
  if (typeof confidence === 'number') return confidence;
  if (confidence === 'HIGH') return 0.9;
  if (confidence === 'MEDIUM') return 0.65;
  if (confidence === 'LOW') return 0.35;
  return null;
}

function normalizeDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return value;

  const text = String(value);
  const natural = text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i);
  if (natural) {
    const months = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const [, day, month, year] = natural;
    return `${year}-${months[month.slice(0, 3).toLowerCase()]}-${day.padStart(2, '0')}`;
  }

  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (numeric) {
    const [, day, month, rawYear] = numeric;
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function mapDocument(doc = {}, applicationId = null) {
  const documentDate = doc.document_date || doc.date || null;
  return {
    application_id: applicationId || doc.application_id || null,
    document_name: doc.document_name || doc.name || doc.originalName || 'Document',
    description: doc.description || null, // migration 008 (Capita gvResults Label2)
    document_type: doc.document_type || doc.type || null,
    document_category: doc.document_category || doc.category || doc.type || null,
    document_date: normalizeDate(documentDate),
    source_url: doc.source_url || doc.sourceUrl || doc.url,
    local_path: doc.local_path || doc.localPath || null,
    sha256_hash: doc.sha256_hash || doc.sha256 || doc.hash || null,
    mime_type: doc.mime_type || doc.mimeType || null,
    file_size: doc.file_size || doc.sizeBytes || null,
    confidence_score: confidenceToScore(doc.confidence_score ?? doc.confidence),
    extraction_status: doc.extraction_status || doc.status || null,
    storage_bucket: doc.storage_bucket || doc.storageBucket || null,
    storage_path: doc.storage_path || doc.storagePath || null,
    storage_mime_type: doc.storage_mime_type || doc.storageMimeType || null,
    storage_uploaded_at: doc.storage_uploaded_at || doc.storageUploadedAt || null,
    extraction_method: doc.extraction_method || doc.extractionMethod || null, // migration 006
    error_message: doc.error_message || doc.error || null,                    // migration 006
    // Change detection (migration 007):
    //   first_seen_at is DELIBERATELY OMITTED — the DB default now() sets it on
    //   INSERT, and because we never send it, an UPSERT-update leaves it intact.
    //   last_seen_at is bumped on every upsert (incl. skipped_known), so a
    //   still-present document's observation time advances even when we skip
    //   re-downloading it.
    last_seen_at: doc.last_seen_at || doc.lastSeenAt || new Date().toISOString(),
    //   NOTE: this is the document LIFECYCLE status ('active' | 'removed'), NOT
    //   the download status. `doc.status` is the DOWNLOAD status (it already
    //   feeds extraction_status above), so we read `record_status` to avoid that
    //   collision. 'removed' detection is Phase 5; everything we see now is active.
    status: doc.record_status || 'active',
  };
}

/**
 * Upserts a document for an application.
 * @param {object} doc
 * @param {string} applicationId
 * @returns {Promise<object|null>}
 */
async function upsertDocument(doc, applicationId) {
  const client = getClientOrNull();
  const row = mapDocument(doc, applicationId);
  if (!client || !row.application_id || !row.source_url) return null;

  return executeWithRetry(async () => client
    .from('documents')
    .upsert(row, { onConflict: 'application_id,source_url' })
    .select()
    .single());
}

/**
 * Upserts a document after resolving or creating the parent application.
 * @param {object} doc
 * @param {object} application
 * @returns {Promise<object|null>}
 */
async function upsertDocumentForApplication(doc, application) {
  const appRow = await applicationsRepository.upsertApplication(application);
  return upsertDocument(doc, appRow && appRow.id);
}

/**
 * Batch upserts documents.
 * @param {object[]} docs
 * @param {string} applicationId
 * @returns {Promise<object[]>}
 */
async function upsertDocuments(docs = [], applicationId) {
  const client = getClientOrNull();
  const rows = docs.map(doc => mapDocument(doc, applicationId)).filter(r => r.application_id && r.source_url);
  if (!client || rows.length === 0) return [];

  return executeWithRetry(async () => client
    .from('documents')
    .upsert(rows, { onConflict: 'application_id,source_url' })
    .select());
}

/**
 * Finds a document by source URL.
 * @param {string} sourceUrl
 * @returns {Promise<object|null>}
 */
async function findBySourceUrl(sourceUrl) {
  const client = getClientOrNull();
  if (!client || !sourceUrl) return null;
  return executeWithRetry(async () => client
    .from('documents')
    .select('*')
    .eq('source_url', sourceUrl)
    .maybeSingle());
}

/**
 * Lists documents with pagination.
 * @param {{ page?: number, pageSize?: number, applicationId?: string, category?: string }} options
 * @returns {Promise<{ data: object[], count: number, page: number, pageSize: number }>}
 */
async function listDocuments(options = {}) {
  const client = getClientOrNull();
  const { page, pageSize, from, to } = normalizePage(options.page, options.pageSize);
  if (!client) return { data: [], count: 0, page, pageSize };

  let query = client.from('documents').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
  if (options.applicationId) query = query.eq('application_id', options.applicationId);
  if (options.category) query = query.eq('document_category', options.category);
  const { data, count, error } = await query;
  if (error) throw error;
  return { data: data || [], count: count || 0, page, pageSize };
}

/**
 * Lists documents that have a file in Storage, joined with their parent
 * application, for the intelligence pipeline. Paginates internally so it can
 * return the full set regardless of size.
 * @returns {Promise<object[]>} documents, each with a nested `applications` row
 */
async function listStoredDocuments() {
  const client = getClientOrNull();
  if (!client) return [];

  const pageSize = 500;
  let fromRow = 0;
  const all = [];

  // Loop pages until exhausted.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await client
      .from('documents')
      .select('*, applications(id, application_uid, council, address, proposal, received_at)')
      .not('storage_path', 'is', null)
      .order('created_at', { ascending: true })
      .range(fromRow, fromRow + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    fromRow += pageSize;
  }

  return all;
}

module.exports = {
  confidenceToScore,
  normalizeDate,
  mapDocument,
  upsertDocument,
  upsertDocuments,
  upsertDocumentForApplication,
  findBySourceUrl,
  listDocuments,
  listStoredDocuments,
};
