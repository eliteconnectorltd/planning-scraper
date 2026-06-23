'use strict';

const { executeWithRetry, getClientOrNull, normalizePage } = require('./baseRepository');

function mapApplication(app = {}) {
  return {
    application_uid: app.application_uid || app.title || app.application_id || app.uid,
    council: app.council || app.area || null,
    platform: app.platform || null,
    address: app.address || null,
    proposal: app.proposal || app.description || null,
    status: app.status || null,
    applicant: app.applicant || null,
    agent: app.agent || null,
    application_type: app.application_type || app.applicationType || null,
    source_url: app.source_url || app.sourceUrl || null,
    documents_url: app.documents_url || app.docsUrl || null,
    validated_at: app.validated_at || null,
    received_at: app.received_at || app.startDate || null,
    decision: app.decision || null,
    decision_date: app.decision_date || app.decisionDate || null,
    scrape_status: app.scrape_status || app.scrapeStatus || null,
  };
}

/**
 * @typedef {object} ApplicationRow
 * @property {string} id
 * @property {string} application_uid
 * @property {string|null} council
 * @property {string|null} platform
 * @property {string|null} scrape_status
 */

/**
 * Upserts a planning application by `application_uid`.
 * @param {object} app
 * @returns {Promise<ApplicationRow|null>}
 */
async function upsertApplication(app) {
  const client = getClientOrNull();
  const row = mapApplication(app);
  if (!client || !row.application_uid) return null;

  return executeWithRetry(async () => client
    .from('applications')
    .upsert(row, { onConflict: 'application_uid' })
    .select()
    .single());
}

/**
 * Batch upsert applications by `application_uid`.
 * @param {object[]} apps
 * @returns {Promise<ApplicationRow[]>}
 */
async function upsertApplications(apps = []) {
  const client = getClientOrNull();
  const rows = apps.map(mapApplication).filter(r => r.application_uid);
  if (!client || rows.length === 0) return [];

  return executeWithRetry(async () => client
    .from('applications')
    .upsert(rows, { onConflict: 'application_uid' })
    .select());
}

/**
 * Finds one application by UID.
 * @param {string} applicationUid
 * @returns {Promise<ApplicationRow|null>}
 */
async function findByUid(applicationUid) {
  const client = getClientOrNull();
  if (!client || !applicationUid) return null;
  return executeWithRetry(async () => client
    .from('applications')
    .select('*')
    .eq('application_uid', applicationUid)
    .maybeSingle());
}

/**
 * Lists applications with pagination and optional filters.
 * @param {{ page?: number, pageSize?: number, council?: string, decision?: string, status?: string, query?: string }} options
 * @returns {Promise<{ data: ApplicationRow[], count: number, page: number, pageSize: number }>}
 */
async function listApplications(options = {}) {
  const client = getClientOrNull();
  const { page, pageSize, from, to } = normalizePage(options.page, options.pageSize);
  if (!client) return { data: [], count: 0, page, pageSize };

  let query = client.from('applications').select('*', { count: 'exact' }).order('updated_at', { ascending: false }).range(from, to);
  if (options.council) query = query.eq('council', options.council);
  if (options.decision) query = query.eq('decision', options.decision);
  if (options.status) query = query.eq('status', options.status);
  if (options.query) {
    const q = `%${options.query}%`;
    query = query.or(`application_uid.ilike.${q},address.ilike.${q},proposal.ilike.${q}`);
  }

  const response = await executeWithRetry(async () => query);
  return { data: response || [], count: 0, page, pageSize };
}

module.exports = {
  mapApplication,
  upsertApplication,
  upsertApplications,
  findByUid,
  listApplications,
};
