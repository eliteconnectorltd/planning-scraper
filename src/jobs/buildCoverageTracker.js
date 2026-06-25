'use strict';

/**
 * src/jobs/buildCoverageTracker.js
 *
 * Focused coverage tracker scoped to the ~120 rows in our postcode_areas table.
 * For each row we enrich with:
 *   - what Planit's authority list knows (matched by URL, then hostname)
 *   - the platform our detector.js would pick (same logic as the live scraper)
 *   - whether our adapters support that platform
 *   - whether a registered service provider (sp_contact_profiles) covers it
 *
 * Outputs (under output/):
 *   coverage_tracker.csv       — one row per postcode_areas row, sorted by live_status
 *   coverage_by_platform.csv   — same rows, sorted by adapter_status
 *   coverage_summary.json      — counts and totals
 *
 * Read-only: queries postcode_areas + sp_contact_profiles, fetches Planit areas.
 * Does NOT modify any table, adapter, the detector, or postcode_areas.
 *
 * Run: npm run build-coverage
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const { getClientOrNull } = require('../db/repositories/baseRepository');
const { getCoveredPostcodeAreas } = require('../db/repositories/spProfilesRepository');
const { detectPlatform } = require('../detector');

// ── Config ───────────────────────────────────────────────────────────────────
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
const TRACKER_CSV = path.join(OUTPUT_DIR, 'coverage_tracker.csv');
const BY_PLATFORM_CSV = path.join(OUTPUT_DIR, 'coverage_by_platform.csv');
const SUMMARY_JSON = path.join(OUTPUT_DIR, 'coverage_summary.json');

const PLANIT_AREAS_URL = 'https://www.planit.org.uk/api/areas/json';
const PAGE_SIZE = 500;
const PAGE_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 60000;
// Fields we need from each Planit authority — excludes the huge `borders` geometry.
const PLANIT_SELECT = 'area_id,area_name,long_name,area_type,is_planning,scraper_name,planning_url,in_region,parent_name,total,max_date,notes';

// Ordering for the two CSVs.
const LIVE_ORDER = ['scrapes_today', 'ready_no_sp', 'blocked_adapter', 'low_priority'];
const ADAPTER_ORDER = [
  'supported', 'supported_haringey', 'partial_salesforce',
  'not_built_northgate', 'not_built_socrata', 'not_built_other', 'no_portal_url',
];

// Output column order (shared by both CSVs).
const COLUMNS = [
  'postcode', 'region', 'source_url', 'extract', 'planit_match_method',
  'detected_platform', 'planit_scraper_type', 'platform_agreement', 'adapter_status',
  'in_sp_coverage', 'live_status', 'planit_area_name', 'planit_long_name',
  'planit_in_region', 'planit_parent_name', 'planit_total_applications',
  'planit_max_date', 'planit_notes',
];

const delay = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s == null ? '' : s).toLowerCase().trim();
function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

// ── Low-level JSON fetch (mirrors planit.js headers; no import to avoid coupling) ─
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-GB,en;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.planit.org.uk/',
        'Connection': 'keep-alive',
      },
      timeout: FETCH_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        return fetchJson(redirectUrl).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error(`HTTP ${res.statusCode}`);
        err.statusCode = res.statusCode;
        return reject(err);
      }
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Socket Timeout (${FETCH_TIMEOUT_MS}ms)`)));
    req.on('error', reject);
  });
}

// ── Step 1: our postcode_areas master list ────────────────────────────────────
async function loadPostcodeAreas() {
  const client = getClientOrNull();
  if (!client) throw new Error('Supabase client unavailable (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)');
  const { data, error } = await client
    .from('postcode_areas')
    .select('id, postcode, region, source_url, extract')
    .order('postcode', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ── Step 3: Planit authority list (paginated) ─────────────────────────────────
async function fetchPlanitAuthorities() {
  const records = [];
  let page = 1;
  let total = Infinity;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const url = `${PLANIT_AREAS_URL}?pg_sz=${PAGE_SIZE}&page=${page}&select=${encodeURIComponent(PLANIT_SELECT)}`;
      const json = await fetchJson(url);
      const recs = Array.isArray(json.records) ? json.records : [];
      if (Number.isFinite(Number(json.total))) total = Number(json.total);

      for (const r of recs) {
        if (r && typeof r === 'object') delete r.borders; // drop geometry if present
        records.push(r);
      }

      const to = Number(json.to) || records.length;
      const totalPages = Number.isFinite(total) ? Math.ceil(total / PAGE_SIZE) : '?';
      if (page === 1 || page % 5 === 0) {
        console.log(`Fetching Planit page ${page} of ${totalPages}`);
      }

      if (recs.length === 0 || records.length >= total || to >= total) break;
      page++;
      await delay(PAGE_DELAY_MS);
    }
    return { records, complete: true };
  } catch (err) {
    console.error(`[coverage] Planit fetch FAILED on page ${page}: ${err.message}. Marking unmatched rows as fetch_failed.`);
    return { records, complete: false };
  }
}

// ── Lookup maps ───────────────────────────────────────────────────────────────
function buildPlanitMaps(authorities) {
  const planning = authorities.filter(r => r && r.is_planning === true);
  const planitByUrl = new Map();
  const planitByHost = new Map();
  const planitByName = new Map();

  for (const r of planning) {
    const purl = norm(r.planning_url);
    if (purl && !planitByUrl.has(purl)) planitByUrl.set(purl, r);
    const h = hostOf(r.planning_url);
    if (h && !planitByHost.has(h)) planitByHost.set(h, r);
    const ln = norm(r.long_name);
    if (ln && !planitByName.has(ln)) planitByName.set(ln, r);
    const an = norm(r.area_name);
    if (an && !planitByName.has(an)) planitByName.set(an, r);
  }

  return { planning, planitByUrl, planitByHost, planitByName };
}

function matchPlanit(sourceUrl, maps) {
  if (!sourceUrl) return { method: 'none', rec: null };
  const key = norm(sourceUrl);
  if (maps.planitByUrl.has(key)) return { method: 'exact_url', rec: maps.planitByUrl.get(key) };
  const h = hostOf(sourceUrl);
  if (h && maps.planitByHost.has(h)) return { method: 'hostname', rec: maps.planitByHost.get(h) };
  return { method: 'none', rec: null };
}

// ── Enrichment helpers ────────────────────────────────────────────────────────
function adapterStatusFor(detected, planitAreaName, sourceUrl) {
  if (!sourceUrl) return 'no_portal_url';
  switch (detected) {
    case 'idox':
    case 'arcus':
      return 'supported';
    case 'salesforce': {
      // Spec: Haringey = supported. Use the matched Planit area_name AND the URL
      // host as signals (publicregister.haringey.gov.uk), since some rows have no
      // Planit match but the URL still clearly says haringey.
      const isHaringey = /haringey/i.test(planitAreaName || '') || /haringey/i.test(sourceUrl || '');
      return isHaringey ? 'supported_haringey' : 'partial_salesforce';
    }
    case 'northgate':
      return 'not_built_northgate';
    case 'socrata':
      return 'not_built_socrata';
    default:
      return 'not_built_other'; // unknown / custom / bespoke
  }
}

function platformAgreement(detected, planitScraper) {
  // 'n/a' if either side is missing (or detector couldn't classify).
  if (!planitScraper || !detected || detected === 'unknown') return 'n/a';
  const a = detected.toLowerCase();
  const b = String(planitScraper).toLowerCase();
  return (a === b || b.includes(a) || a.includes(b)) ? 'yes' : 'no';
}

function liveStatusFor(adapterStatus, inSp) {
  if (adapterStatus === 'supported' && inSp === 'yes') return 'scrapes_today';
  if (adapterStatus === 'supported' && inSp === 'no') return 'ready_no_sp';
  if ((adapterStatus.startsWith('not_built') || adapterStatus.startsWith('partial')) && inSp === 'yes') {
    return 'blocked_adapter';
  }
  return 'low_priority';
}

// ── CSV helpers ───────────────────────────────────────────────────────────────
function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows) {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(COLUMNS.map(col => csvEscape(row[col])).join(','));
  }
  return lines.join('\n') + '\n';
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Step 1 — postcode_areas master list
  const pcRows = await loadPostcodeAreas();
  console.log(`Loaded ${pcRows.length} postcode_areas rows`);

  // Step 2 — SP coverage
  const { areas: spAreas } = await getCoveredPostcodeAreas();
  const spList = [...spAreas].sort();
  console.log(`Loaded SP areas: ${spList.join(', ') || '(none)'}`);

  // Step 3 — Planit authorities
  const { records: authorities, complete: planitComplete } = await fetchPlanitAuthorities();
  const maps = buildPlanitMaps(authorities);
  console.log(`Planit fetch ${planitComplete ? 'complete' : 'INCOMPLETE'}: ${maps.planning.length} authorities loaded (is_planning=true)`);

  // Step 4 — enrich every postcode_areas row
  const matchCounts = { exact_url: 0, hostname: 0, none: 0, fetch_failed: 0 };
  const rows = [];

  for (const pc of pcRows) {
    const sourceUrl = pc.source_url || '';
    let { method, rec } = matchPlanit(sourceUrl, maps);
    // If unmatched but the Planit fetch was incomplete, we can't claim 'none'.
    if (method === 'none' && sourceUrl && !planitComplete) {
      method = 'fetch_failed';
      rec = null;
    }
    matchCounts[method] = (matchCounts[method] || 0) + 1;

    const detected = detectPlatform(sourceUrl);
    const planitAreaName = rec ? (rec.area_name || '') : '';
    const planitScraper = rec ? (rec.scraper_name || rec.scraper || rec.scraper_type || '') : '';

    const adapter_status = adapterStatusFor(detected, planitAreaName, sourceUrl);
    const areaPrefix = String(pc.postcode || '').trim().toUpperCase();
    const in_sp_coverage = spAreas.has(areaPrefix) ? 'yes' : 'no';
    const platform_agreement = platformAgreement(detected, planitScraper);
    const live_status = liveStatusFor(adapter_status, in_sp_coverage);

    rows.push({
      postcode: pc.postcode || '',
      region: pc.region || '',
      source_url: sourceUrl,
      extract: pc.extract === true ? 'true' : 'false',
      planit_match_method: method,
      detected_platform: detected,
      planit_scraper_type: planitScraper,
      platform_agreement,
      adapter_status,
      in_sp_coverage,
      live_status,
      planit_area_name: planitAreaName,
      planit_long_name: rec ? (rec.long_name || '') : '',
      planit_in_region: rec ? (rec.in_region || '') : '',
      planit_parent_name: rec ? (rec.parent_name || '') : '',
      planit_total_applications: rec && rec.total != null ? rec.total : '',
      planit_max_date: rec ? (rec.max_date || '') : '',
      planit_notes: rec ? (rec.notes || '') : '',
    });
  }

  console.log(`Matching... exact_url=${matchCounts.exact_url}, hostname=${matchCounts.hostname}, none=${matchCounts.none}` +
    (matchCounts.fetch_failed ? `, fetch_failed=${matchCounts.fetch_failed}` : ''));

  // Step 5 — coverage_tracker.csv (sort by live_status, then postcode)
  const trackerRows = [...rows].sort((a, b) => {
    const d = LIVE_ORDER.indexOf(a.live_status) - LIVE_ORDER.indexOf(b.live_status);
    return d !== 0 ? d : String(a.postcode).localeCompare(String(b.postcode));
  });
  fs.writeFileSync(TRACKER_CSV, toCsv(trackerRows), 'utf8');

  // Step 6 — coverage_by_platform.csv (adapter_status, then in_sp yes-first, then postcode)
  const platformRows = [...rows].sort((a, b) => {
    const d = ADAPTER_ORDER.indexOf(a.adapter_status) - ADAPTER_ORDER.indexOf(b.adapter_status);
    if (d !== 0) return d;
    if (a.in_sp_coverage !== b.in_sp_coverage) return a.in_sp_coverage === 'yes' ? -1 : 1;
    return String(a.postcode).localeCompare(String(b.postcode));
  });
  fs.writeFileSync(BY_PLATFORM_CSV, toCsv(platformRows), 'utf8');

  // Step 7 — coverage_summary.json
  const countBy = (key) => rows.reduce((acc, r) => { acc[r[key]] = (acc[r[key]] || 0) + 1; return acc; }, {});
  const disagreements = rows.filter(r => r.platform_agreement === 'no');
  const summary = {
    total_postcodes_tracked: rows.length,
    by_adapter_status: countBy('adapter_status'),
    by_detected_platform: countBy('detected_platform'),
    by_live_status: countBy('live_status'),
    sp_coverage_summary: {
      postcodes_with_sp: rows.filter(r => r.in_sp_coverage === 'yes').length,
      postcodes_without_sp: rows.filter(r => r.in_sp_coverage === 'no').length,
      sp_areas_loaded: spList,
    },
    planit_match_summary: {
      exact_url: matchCounts.exact_url || 0,
      hostname: matchCounts.hostname || 0,
      none: matchCounts.none || 0,
      fetch_failed: matchCounts.fetch_failed || 0,
    },
    platform_disagreements_count: disagreements.length,
    platform_disagreement_examples: disagreements.slice(0, 5).map(r => ({
      postcode: r.postcode, detected: r.detected_platform, planit: r.planit_scraper_type,
    })),
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(SUMMARY_JSON, JSON.stringify(summary, null, 2), 'utf8');

  // Step 8 — sanity print: top 10 rows by live_status
  console.log('\nTop 10 rows by live_status:');
  console.log('  postcode  live_status      adapter_status        in_sp  detected     planit_match');
  for (const r of trackerRows.slice(0, 10)) {
    console.log(
      `  ${String(r.postcode).padEnd(9)} ${String(r.live_status).padEnd(16)} ${String(r.adapter_status).padEnd(21)} ` +
      `${String(r.in_sp_coverage).padEnd(6)} ${String(r.detected_platform).padEnd(12)} ${r.planit_match_method}`
    );
  }

  // ── VERIFY ──────────────────────────────────────────────────────────────────
  const byLive = countBy('live_status');
  console.log('\n=== VERIFY ===');
  console.log(`Total rows in tracker:        ${rows.length}`);
  console.log(`postcode_areas row count:     ${pcRows.length}`);
  console.log(`Row counts match:             ${rows.length === pcRows.length ? 'YES' : 'NO — MISMATCH!'}`);
  console.log(`Distribution by live_status:  ${JSON.stringify(byLive)}`);

  const sample = (status, n) => rows.filter(r => r.live_status === status).slice(0, n);
  const fmt = r => `${r.postcode} | ${r.adapter_status} | sp=${r.in_sp_coverage} | ${r.detected_platform} | ${r.source_url || '(no url)'}`;

  console.log('\n3 examples of scrapes_today:');
  const todays = sample('scrapes_today', 3);
  if (todays.length === 0) console.log('  (none)');
  else todays.forEach(r => console.log(`  ${fmt(r)}`));

  console.log('\n3 examples of blocked_adapter (real SP coverage, no adapter — most actionable):');
  const blocked = sample('blocked_adapter', 3);
  if (blocked.length === 0) console.log('  (none)');
  else blocked.forEach(r => console.log(`  ${fmt(r)}`));

  console.log('\nOutput files:');
  console.log(`  ${TRACKER_CSV}`);
  console.log(`  ${BY_PLATFORM_CSV}`);
  console.log(`  ${SUMMARY_JSON}`);
}

main().catch(err => {
  console.error(`[coverage] Fatal: ${err.message}`);
  process.exit(1);
});
