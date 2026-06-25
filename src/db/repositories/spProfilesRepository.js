'use strict';

/**
 * spProfilesRepository.js
 *
 * Read-only access to `sp_contact_profiles` — the registered service providers.
 * Each row has a `postcode_areas TEXT[]` column listing the UK postcode AREAS
 * (the 1-2 letter prefix before the outward-code digits, e.g. "NG", "S", "SW")
 * that provider covers.
 *
 * Coverage = the union of every provider's postcode_areas. We do NOT consider
 * is_verified — any row counts. One query, set built in memory (dataset is tiny).
 */

const { getClientOrNull } = require('./baseRepository');

// A valid UK postcode area is exactly 1 or 2 uppercase letters.
const AREA_PATTERN = /^[A-Z]{1,2}$/;

/**
 * Builds the set of covered postcode areas across all service providers.
 *
 * @returns {Promise<{ areas: Set<string>, count: number, spCount: number }>}
 *   - areas: uppercase 1-2 letter postcode areas covered by ≥1 provider
 *   - count: areas.size
 *   - spCount: number of sp_contact_profiles rows read
 * Returns an empty set (count 0, spCount 0) if Supabase is not configured.
 * THROWS if the query errors — the caller (loadFilter) handles fail-closed.
 */
async function getCoveredPostcodeAreas() {
  const client = getClientOrNull();
  if (!client) return { areas: new Set(), count: 0, spCount: 0 };

  // Single query — only the column we need.
  const { data, error } = await client
    .from('sp_contact_profiles')
    .select('postcode_areas');
  if (error) throw error;

  const rows = data || [];
  const areas = new Set();
  const bad = [];

  for (const row of rows) {
    const list = Array.isArray(row && row.postcode_areas) ? row.postcode_areas : [];
    for (const raw of list) {
      if (typeof raw !== 'string') {
        if (raw !== null && raw !== undefined) bad.push(String(raw));
        continue;
      }
      const cleaned = raw.trim().toUpperCase();
      if (!cleaned) continue;                 // empty / whitespace-only
      if (!AREA_PATTERN.test(cleaned)) {       // not a 1-2 letter area
        bad.push(raw);
        continue;
      }
      areas.add(cleaned);
    }
  }

  // Surface dirty data once, but don't let it break the filter.
  if (bad.length > 0) {
    console.warn(
      `[sp-profiles] WARNING: ignored ${bad.length} invalid postcode_areas value(s): ` +
      `${[...new Set(bad)].join(', ')}`
    );
  }

  return { areas, count: areas.size, spCount: rows.length };
}

module.exports = { getCoveredPostcodeAreas };
