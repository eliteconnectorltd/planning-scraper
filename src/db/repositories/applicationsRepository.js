'use strict';

const { executeWithRetry, getClientOrNull, normalizePage } = require('./baseRepository');
const { isTerminalStatus } = require('../../utils/terminalStatus');

/**
 * Maps an application object to a DB row.
 *
 * @param {object} app
 * @param {object} [opts] change-detection controls (migration 007). Most call
 *   sites pass nothing → behaviour is unchanged. The three change-detection
 *   columns are CONDITIONALLY included so a thin upsert can't clobber them:
 *   @param {boolean} [opts.lastChecked]      include last_checked_at=now() (only
 *      sites that actually attempted document extraction set this).
 *   @param {boolean} [opts.documentsChanged] include documents_last_changed_at=now().
 *   @param {number}  [opts.recheckCount]     include recheck_count=<n>.
 *   @param {Date}    [opts.now]              injectable clock for tests.
 */
function mapApplication(app = {}, opts = {}) {
  const row = {
    application_uid: app.application_uid || app.title || app.application_id || app.uid,
    council: app.council || app.area || null,
    platform: app.platform || null,
    address: app.address || null,
    proposal: app.proposal || app.description || null,
    status: app.status || null,
    applicant: app.applicant || null,
    agent: app.agent || null,
    case_officer: app.case_officer || null, // migration 005
    application_type: app.application_type || app.applicationType || null,
    source_url: app.source_url || app.sourceUrl || null,
    documents_url: app.documents_url || app.docsUrl || null,
    validated_at: app.validated_at || null,
    received_at: app.received_at || app.startDate || null,
    decision: app.decision || null,
    decision_date: app.decision_date || app.decisionDate || null,
    // Extended Planit metadata columns (migration 004). Numeric columns use ??
    // so a legitimate 0 (e.g. n_comments) is preserved, not coerced to null.
    decided_by: app.decided_by || null,
    postcode: app.postcode || null,
    ward_name: app.ward_name || null,
    uprn: app.uprn || null,
    planning_portal_id: app.planning_portal_id || null,
    lat: app.lat ?? null,
    lng: app.lng ?? null,
    easting: app.easting ?? null,
    northing: app.northing ?? null,
    n_statutory_days: app.n_statutory_days ?? null,
    n_documents: app.n_documents ?? app.nDocuments ?? null,
    n_constraints: app.n_constraints ?? null,
    n_comments: app.n_comments ?? null,
    agent_company: app.agent_company || null,
    agent_address: app.agent_address || null,
    target_decision_date: app.target_decision_date || null,
    consultation_start_date: app.consultation_start_date || null,
    comment_url: app.comment_url || null,
    map_url: app.map_url || null,
    scrape_status: app.scrape_status || app.scrapeStatus || null,
  };

  // ── Change-detection columns (migration 007) — CONDITIONALLY included ───────
  // These break the "emit every column" rule on purpose: emitting null/false for
  // them on every upsert would clobber the DB value on thin status-only writes.
  // We only add the key when the caller signals it applies; otherwise the column
  // is left untouched on update (and uses its DB default on first insert).
  const now = opts.now || new Date();

  // last_checked_at: ONLY when we actually attempted document extraction
  // (terminal-skip, post-scrape, resume re-check). Use updated_at for generic
  // "last touched". Not stamped on filter/queued/missing_url/generic_disabled.
  if (opts.lastChecked === true) row.last_checked_at = now;

  // is_terminal: emit a concrete boolean ONLY when the status is KNOWN.
  //   - status set + terminal     → true
  //   - status set + not terminal → false (explicit, so known-active rows are
  //                                 false, not null — fixes pre-migration/thin-
  //                                 upsert nulls going forward)
  //   - status absent             → OMIT (preserve existing DB value; a thin
  //                                 upsert that doesn't carry status must never
  //                                 flip a previously-terminal app back to active)
  if (app.status) row.is_terminal = isTerminalStatus(app.status);

  // documents_last_changed_at: ONLY when the orchestrator detected a change.
  if (opts.documentsChanged === true) row.documents_last_changed_at = now;

  // recheck_count: ONLY when the caller computed it (read-before-write).
  if (typeof opts.recheckCount === 'number') row.recheck_count = opts.recheckCount;

  return row;
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
 * @param {object} [opts] forwarded to mapApplication (change-detection columns)
 * @returns {Promise<ApplicationRow|null>}
 */
async function upsertApplication(app, opts = {}) {
  const client = getClientOrNull();
  const row = mapApplication(app, opts);
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

  // Read data AND the exact count from the same response (matches the pattern in
  // listDocuments/listChanges). The previous code discarded count and hardcoded 0.
  const { data, count, error } = await query;
  if (error) throw error;
  return { data: data || [], count: count || 0, page, pageSize };
}

module.exports = {
  mapApplication,
  upsertApplication,
  upsertApplications,
  findByUid,
  listApplications,
};
