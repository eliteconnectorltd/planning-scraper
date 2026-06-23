'use strict';

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Wraps global fetch with a hard timeout so a dead/unreachable Supabase project
// fails fast instead of hanging the scraper for 30+ seconds per call.
function fetchWithTimeout(url, options = {}) {
  const timeoutMs = 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Set SUPABASE_DEBUG=1 to surface configuration problems that would otherwise
// be hidden by the best-effort .catch() wrappers at every call site. This logs
// once, on first client creation — it never changes behavior or throws.
function warnOnSuspiciousConfig() {
  if (process.env.SUPABASE_DEBUG !== '1') return;
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  console.log(`[supabase] URL = ${url}`);
  if (key.startsWith('sb_publishable_') || key.startsWith('sb_anon_')) {
    console.warn(
      '[supabase] WARNING: SUPABASE_SERVICE_ROLE_KEY looks like a PUBLISHABLE/anon key ' +
      `(prefix "${key.split('_').slice(0, 2).join('_')}_…"). Writes and bucket creation ` +
      'will be blocked by RLS. Use the SECRET service-role key (prefix "sb_secret_" or a legacy "eyJ…" JWT).'
    );
  }
}

function getSupabaseClient() {
  if (!isSupabaseConfigured()) return null;
  if (!cachedClient) {
    warnOnSuspiciousConfig();
    cachedClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchWithTimeout },
    });
  }
  return cachedClient;
}

async function withSupabase(operation, fallback = null) {
  const client = getSupabaseClient();
  if (!client) return fallback;
  return operation(client);
}

module.exports = {
  getSupabaseClient,
  isSupabaseConfigured,
  withSupabase,
};
