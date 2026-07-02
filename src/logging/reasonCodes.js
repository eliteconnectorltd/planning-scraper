'use strict';

/**
 * reasonCodes.js — derive machine-readable reason codes (+ structured error fields)
 * for document_download and adapter_metadata scrape_events. Pure functions, unit-
 * testable. Consumed by src/index.js when building event `details`.
 *
 * Vocabulary (kept in sync with dashboard run-format.reasonCodeColor):
 *   downloaded            — fetched + stored in Supabase Storage
 *   downloaded_no_storage — fetched OK but Storage upload failed (local fallback)
 *   skipped_known_url     — already downloaded in a prior run (cross-run dedup)
 *   skipped_duplicate_hash— same SHA-256 as another doc this run
 *   failed_http_<code>    — portal returned HTTP >= 400
 *   failed_network        — DNS/connection/reset/dns failure
 *   failed_timeout        — request aborted/timed out
 *   failed_other          — anything else
 */

/** Extract a 3-digit HTTP status from an error message like "HTTP Error: 404". */
function parseHttpStatus(msg) {
  const m = /(?:http\s*error:?|status:?|http)\s*(\d{3})\b/i.exec(String(msg || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Derive reason fields for a document download from the downloadManager result.
 * @param {{status?:string, error?:string|null, sizeBytes?:number, storagePath?:string}} rec
 * @returns {{reason_code:string, reason_message?:string, http_status?:number, error_message?:string}}
 */
function documentReason(rec = {}) {
  const status = rec.status || 'unknown';
  switch (status) {
    case 'downloaded':
      return { reason_code: 'downloaded' };
    case 'downloaded_no_storage':
      return { reason_code: 'downloaded_no_storage', reason_message: rec.error || 'Storage upload failed; local fallback used' };
    case 'skipped_known':
      return { reason_code: 'skipped_known_url', reason_message: 'Already downloaded in a prior run' };
    case 'skipped_duplicate':
      return { reason_code: 'skipped_duplicate_hash', reason_message: 'Same SHA-256 as another document this run' };
    case 'failed': {
      const msg = rec.error || 'unknown error';
      const http = parseHttpStatus(msg);
      if (http) return { reason_code: `failed_http_${http}`, reason_message: msg, http_status: http, error_message: msg };
      if (/timeout|timed out|aborted|abort/i.test(msg)) return { reason_code: 'failed_timeout', reason_message: msg, error_message: msg };
      // Playwright/downloadManager masks the underlying net error behind generic
      // phrasing ("Navigation failed and no download event fired"); treat those —
      // plus explicit net::/errno signals — as network failures.
      if (/net::|err_|enotfound|econnrefused|econnreset|eai_again|getaddrinfo|socket hang up|dns|network|navigation failed|no download event/i.test(msg)) {
        return { reason_code: 'failed_network', reason_message: msg, error_message: msg };
      }
      return { reason_code: 'failed_other', reason_message: msg, error_message: msg };
    }
    default:
      return { reason_code: status };
  }
}

/**
 * Derive reason fields for an adapter metadata extraction.
 * @param {object|null} metadata the adapter's returned metadata object (may be null)
 * @returns {{reason_code:string, reason_message?:string, fields_captured:string[], fields_attempted:string[], fields_null:string[]}}
 */
function metadataReason(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return { reason_code: 'metadata_none', reason_message: 'Adapter returned no metadata object', fields_captured: [], fields_attempted: [], fields_null: [] };
  }
  const attempted = Object.keys(metadata);
  const captured = attempted.filter(k => metadata[k] != null && String(metadata[k]).trim() !== '');
  const nulls = attempted.filter(k => !captured.includes(k));
  if (captured.length === 0) {
    return { reason_code: 'metadata_empty', reason_message: 'Adapter returned a metadata object but every field was null', fields_captured: [], fields_attempted: attempted, fields_null: nulls };
  }
  return {
    reason_code: 'metadata_captured',
    reason_message: `${captured.length}/${attempted.length} field(s) captured`,
    fields_captured: captured,
    fields_attempted: attempted,
    fields_null: nulls,
  };
}

module.exports = { documentReason, metadataReason, parseHttpStatus };
