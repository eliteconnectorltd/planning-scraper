'use strict';

const { executeWithRetry, getClientOrNull, normalizePage } = require('./baseRepository');

function mapChange(change = {}, applicationId = null) {
  return {
    application_id: applicationId || change.application_id || null,
    change_type: change.change_type || change.type,
    old_value: change.old_value ?? change.previous ?? null,
    new_value: change.new_value ?? change.current ?? null,
    detected_at: change.detected_at || new Date().toISOString(),
  };
}

/**
 * Inserts one change log row.
 * @param {object} change
 * @param {string|null} applicationId
 * @returns {Promise<object|null>}
 */
async function insertChange(change, applicationId = null) {
  const client = getClientOrNull();
  const row = mapChange(change, applicationId);
  if (!client || !row.change_type) return null;
  return executeWithRetry(async () => client.from('change_log').insert(row).select().single());
}

/**
 * Inserts change rows in a batch.
 * @param {object[]} changes
 * @returns {Promise<object[]>}
 */
async function insertChanges(changes = []) {
  const client = getClientOrNull();
  const rows = changes.map(c => mapChange(c)).filter(r => r.change_type);
  if (!client || rows.length === 0) return [];
  return executeWithRetry(async () => client.from('change_log').insert(rows).select());
}

/**
 * Lists change rows with pagination.
 * @param {{ page?: number, pageSize?: number, changeType?: string }} options
 * @returns {Promise<{ data: object[], count: number, page: number, pageSize: number }>}
 */
async function listChanges(options = {}) {
  const client = getClientOrNull();
  const { page, pageSize, from, to } = normalizePage(options.page, options.pageSize);
  if (!client) return { data: [], count: 0, page, pageSize };
  let query = client.from('change_log').select('*', { count: 'exact' }).order('detected_at', { ascending: false }).range(from, to);
  if (options.changeType) query = query.eq('change_type', options.changeType);
  const { data, count, error } = await query;
  if (error) throw error;
  return { data: data || [], count: count || 0, page, pageSize };
}

module.exports = {
  mapChange,
  insertChange,
  insertChanges,
  listChanges,
};
