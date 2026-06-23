'use strict';

const { executeWithRetry, getClientOrNull, normalizePage } = require('./baseRepository');

/**
 * Creates a scraping run row.
 * @param {object} run
 * @returns {Promise<object|null>}
 */
async function startRun(run = {}) {
  const client = getClientOrNull();
  if (!client) return null;
  return executeWithRetry(async () => client
    .from('scraping_runs')
    .insert({
      started_at: run.started_at || new Date().toISOString(),
      run_status: run.run_status || 'running',
    })
    .select()
    .single());
}

/**
 * Updates a scraping run row.
 * @param {string} runId
 * @param {object} patch
 * @returns {Promise<object|null>}
 */
async function updateRun(runId, patch = {}) {
  const client = getClientOrNull();
  if (!client || !runId) return null;
  return executeWithRetry(async () => client
    .from('scraping_runs')
    .update(patch)
    .eq('id', runId)
    .select()
    .single());
}

/**
 * Completes a scraping run.
 * @param {string} runId
 * @param {object} metrics
 * @returns {Promise<object|null>}
 */
async function completeRun(runId, metrics = {}) {
  const runtimeSeconds = metrics.runtime_seconds ?? metrics.runtimeSeconds ?? null;
  return updateRun(runId, {
    completed_at: new Date().toISOString(),
    total_applications: metrics.total_applications ?? metrics.totalApplications ?? 0,
    total_documents: metrics.total_documents ?? metrics.totalDocuments ?? 0,
    successful_downloads: metrics.successful_downloads ?? metrics.successfulDownloads ?? 0,
    failed_downloads: metrics.failed_downloads ?? metrics.failedDownloads ?? 0,
    blocked_requests: metrics.blocked_requests ?? metrics.blockedRequests ?? 0,
    runtime_seconds: runtimeSeconds,
    run_status: metrics.run_status || 'completed',
  });
}

/**
 * Lists scraping runs with pagination.
 * @param {{ page?: number, pageSize?: number, status?: string }} options
 * @returns {Promise<{ data: object[], count: number, page: number, pageSize: number }>}
 */
async function listRuns(options = {}) {
  const client = getClientOrNull();
  const { page, pageSize, from, to } = normalizePage(options.page, options.pageSize);
  if (!client) return { data: [], count: 0, page, pageSize };
  let query = client.from('scraping_runs').select('*', { count: 'exact' }).order('started_at', { ascending: false }).range(from, to);
  if (options.status) query = query.eq('run_status', options.status);
  const { data, count, error } = await query;
  if (error) throw error;
  return { data: data || [], count: count || 0, page, pageSize };
}

module.exports = {
  startRun,
  updateRun,
  completeRun,
  listRuns,
};
