'use strict';

const { executeWithRetry, getClientOrNull, normalizePage } = require('./baseRepository');

function mapIntelligence(record = {}, documentId = null) {
  const classification = record.classification || null;
  return {
    document_id: documentId || record.document_id || null,
    extracted_text: record.extracted_text || record.text || null,
    metadata_json: record.metadata_json || record.metadata || null,
    classification,
    confidence_score: record.confidence_score || (classification && classification.confidence) || null,
    scanned_document: Boolean(record.scanned_document ?? record.ocr?.isScanned),
    extraction_engine: record.extraction_engine || 'pdf-parse',
  };
}

/**
 * Upserts intelligence by document and engine.
 * @param {object} record
 * @param {string} documentId
 * @returns {Promise<object|null>}
 */
async function upsertIntelligence(record, documentId) {
  const client = getClientOrNull();
  const row = mapIntelligence(record, documentId);
  if (!client || !row.document_id) return null;

  return executeWithRetry(async () => client
    .from('intelligence')
    .upsert(row, { onConflict: 'document_id,extraction_engine' })
    .select()
    .single());
}

/**
 * Batch upserts intelligence records.
 * @param {object[]} records
 * @returns {Promise<object[]>}
 */
async function upsertIntelligenceBatch(records = []) {
  const client = getClientOrNull();
  const rows = records.map(r => mapIntelligence(r)).filter(r => r.document_id);
  if (!client || rows.length === 0) return [];
  return executeWithRetry(async () => client
    .from('intelligence')
    .upsert(rows, { onConflict: 'document_id,extraction_engine' })
    .select());
}

/**
 * Lists intelligence records with pagination.
 * @param {{ page?: number, pageSize?: number, documentId?: string }} options
 * @returns {Promise<{ data: object[], count: number, page: number, pageSize: number }>}
 */
async function listIntelligence(options = {}) {
  const client = getClientOrNull();
  const { page, pageSize, from, to } = normalizePage(options.page, options.pageSize);
  if (!client) return { data: [], count: 0, page, pageSize };
  let query = client.from('intelligence').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
  if (options.documentId) query = query.eq('document_id', options.documentId);
  const { data, count, error } = await query;
  if (error) throw error;
  return { data: data || [], count: count || 0, page, pageSize };
}

module.exports = {
  mapIntelligence,
  upsertIntelligence,
  upsertIntelligenceBatch,
  listIntelligence,
};
