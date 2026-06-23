'use strict';

const { getClientOrNull, executeWithRetry } = require('../db/repositories/baseRepository');

const PLATFORM_TYPES = {
  IDOX: 'IDOX',
  PUBLIC_ACCESS: 'PUBLIC_ACCESS',
  SALESFORCE: 'SALESFORCE',
  CUSTOM: 'CUSTOM',
  CLOUDFLARE_PROTECTED: 'CLOUDFLARE_PROTECTED',
  UNKNOWN: 'UNKNOWN',
};

function classifyPortal(url = '', html = '') {
  const lowerUrl = String(url).toLowerCase();
  const lowerHtml = String(html).toLowerCase();
  const sample = `${lowerUrl}\n${lowerHtml}`;

  if (sample.includes('cf-challenge') || sample.includes('turnstile') || sample.includes('verify you are human')) {
    return PLATFORM_TYPES.CLOUDFLARE_PROTECTED;
  }
  if (sample.includes('salesforce') || sample.includes('/s/planning-application/')) {
    return PLATFORM_TYPES.SALESFORCE;
  }
  if (sample.includes('publicaccess')) {
    return PLATFORM_TYPES.PUBLIC_ACCESS;
  }
  if (sample.includes('online-applications') || sample.includes('applicationdetails.do')) {
    return PLATFORM_TYPES.IDOX;
  }
  if (lowerUrl && lowerUrl !== 'null') {
    return PLATFORM_TYPES.CUSTOM;
  }
  return PLATFORM_TYPES.UNKNOWN;
}

async function recordPlatformMetric({ url, platform, success = false, blocked = false, extractionCount = 0, responseMs = 0 }) {
  const client = getClientOrNull();
  if (!client || !url) return null;
  const host = new URL(url).hostname;
  const classified = platform || classifyPortal(url);

  const existing = await executeWithRetry(async () => client
    .from('platform_metrics')
    .select('*')
    .eq('portal_host', host)
    .eq('platform', classified)
    .maybeSingle());

  const row = {
    portal_host: host,
    platform: classified,
    success_count: (existing?.success_count || 0) + (success ? 1 : 0),
    block_count: (existing?.block_count || 0) + (blocked ? 1 : 0),
    total_extractions: (existing?.total_extractions || 0) + Number(extractionCount || 0),
    total_response_ms: (existing?.total_response_ms || 0) + Number(responseMs || 0),
    updated_at: new Date().toISOString(),
  };

  return executeWithRetry(async () => client
    .from('platform_metrics')
    .upsert(row, { onConflict: 'portal_host,platform' })
    .select()
    .single());
}

module.exports = {
  PLATFORM_TYPES,
  classifyPortal,
  recordPlatformMetric,
};
