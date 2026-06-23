'use strict';

const { getSupabaseClient } = require('../supabase');

const DEFAULT_PAGE_SIZE = 100;
const RETRYABLE_CODES = new Set(['40001', '40P01', '53300', '57P01', '57014']);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeWithRetry(operation, options = {}) {
  const { retries = 3, baseDelayMs = 150 } = options;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await operation();
      if (result && result.error) throw result.error;
      return result ? result.data : null;
    } catch (err) {
      lastError = err;
      const retryable = RETRYABLE_CODES.has(err.code) || /timeout|network|fetch/i.test(err.message || '');
      if (!retryable || attempt === retries) break;
      await delay(baseDelayMs * Math.pow(2, attempt));
    }
  }

  throw lastError;
}

function getClientOrNull() {
  return getSupabaseClient();
}

function normalizePage(page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || DEFAULT_PAGE_SIZE, 1), 1000);
  const from = (safePage - 1) * safePageSize;
  const to = from + safePageSize - 1;
  return { page: safePage, pageSize: safePageSize, from, to };
}

async function paginate(table, options = {}) {
  const client = getClientOrNull();
  if (!client) return { data: [], count: 0, page: 1, pageSize: DEFAULT_PAGE_SIZE };

  const { page, pageSize, from, to } = normalizePage(options.page, options.pageSize);
  let query = client.from(table).select(options.select || '*', { count: 'exact' }).range(from, to);

  if (options.orderBy) {
    query = query.order(options.orderBy, { ascending: options.ascending !== false });
  }

  if (typeof options.applyFilters === 'function') {
    query = options.applyFilters(query);
  }

  const { data, count, error } = await query;
  if (error) throw error;
  return { data: data || [], count: count || 0, page, pageSize };
}

module.exports = {
  executeWithRetry,
  getClientOrNull,
  normalizePage,
  paginate,
};
