'use strict';

/**
 * src/core/postcodeFilter.js
 *
 * Orchestrator-level coverage gate: applications are only PROCESSED if their
 * postcode area is covered by at least one registered service provider in
 * sp_contact_profiles. Lives here (not in any adapter) so it applies uniformly
 * to every current and future adapter via src/index.js.
 *
 * Fail-closed by design: if there are no registered providers (or coverage
 * couldn't be loaded), nothing is scraped — there is nobody to scrape for.
 */

const { getCoveredPostcodeAreas } = require('../db/repositories/spProfilesRepository');

// Outward+inward UK postcode; capture group 1 = the leading 1-2 letters
// (the postcode AREA) of the outward code. e.g. "CR7 6DP" → "CR", "W1K 1AA" → "W".
const POSTCODE_AREA_REGEX = /\b([A-Z]{1,2})\d[A-Z\d]?(?:\s*\d[A-Z]{2})?\b/i;

/**
 * Loads the provider-coverage filter once, at the start of a run.
 *
 * Env override: POSTCODE_FILTER_DISABLED=true → "allow all" (logs a loud WARNING).
 * On query error → fail-closed filter (empty areas) + loud ERROR log.
 *
 * @returns {Promise<{ allowAll: boolean, areas: Set<string>, spCount: number, error?: string }>}
 */
async function loadFilter() {
  if (String(process.env.POSTCODE_FILTER_DISABLED || '').toLowerCase() === 'true') {
    console.warn(
      '[filter] ⚠ WARNING: POSTCODE_FILTER_DISABLED=true — postcode-area filtering is OFF. ' +
      'ALL applications will be processed regardless of service-provider coverage.'
    );
    return { allowAll: true, areas: new Set(), spCount: 0 };
  }

  try {
    const { areas, count, spCount } = await getCoveredPostcodeAreas();
    const list = [...areas].sort().join(', ') || '(none)';
    console.log(`[filter] Loaded ${count} postcode area(s) from ${spCount} service provider(s): ${list}`);
    return { allowAll: false, areas, spCount };
  } catch (err) {
    console.error(
      `[filter] ✗ ERROR loading service-provider coverage from sp_contact_profiles: ${err.message}. ` +
      'FAILING CLOSED — all applications will be skipped (reason: no_sps_registered) until this is fixed.'
    );
    return { allowAll: false, areas: new Set(), spCount: 0, error: err.message };
  }
}

/**
 * Decides whether a single application should be processed.
 * First match wins, in this order:
 *   i)   allowAll                       → allowed  (filter_disabled)
 *   ii)  no covered areas at all        → skip     (no_sps_registered) — FAIL CLOSED
 *   iii) postcode area found & covered  → allowed  (area_match, matchedArea)
 *   iv)  no postcode in the address     → skip     (no_postcode_in_address)
 *   v)   postcode found, not covered    → skip     (area_not_covered:<area>)
 *
 * Matching is by postcode extracted from app.address ONLY — never by council
 * name (app.area), which doesn't map reliably to postcode areas.
 *
 * @param {object} app    Enriched Planit application (uses app.address)
 * @param {object} filter Result of loadFilter()
 * @returns {{ allowed: boolean, reason: string, matchedArea?: string }}
 */
function shouldProcess(app, filter) {
  // i) explicit override
  if (filter && filter.allowAll) {
    return { allowed: true, reason: 'filter_disabled' };
  }

  // ii) no providers → nothing to scrape for (fail closed)
  if (!filter || !filter.areas || filter.areas.size === 0) {
    return { allowed: false, reason: 'no_sps_registered' };
  }

  const address = (app && app.address) || '';
  const match = address.match(POSTCODE_AREA_REGEX);

  if (match) {
    const area = match[1].toUpperCase();
    // iii) covered
    if (filter.areas.has(area)) {
      return { allowed: true, reason: 'area_match', matchedArea: area };
    }
    // v) found but not covered
    return { allowed: false, reason: `area_not_covered:${area}` };
  }

  // iv) couldn't find a postcode — can't safely decide, so skip visibly
  return { allowed: false, reason: 'no_postcode_in_address' };
}

module.exports = { loadFilter, shouldProcess };
