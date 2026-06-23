'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const postcodeAreasRepository = require('../db/repositories/postcodeAreasRepository');
const applicationsRepository = require('../db/repositories/applicationsRepository');
const runsRepository = require('../db/repositories/runsRepository');
const { createBrowserContext } = require('../browser');
const { detectPlatform } = require('../detector');
const { scrapeIdoxApplications } = require('../adapters/idoxApplications');
const { recordPlatformMetric } = require('../platforms/fingerprint');

const MAX_APPLICATIONS_PER_LOCATION = Number(process.env.MAX_APPLICATIONS_PER_LOCATION) || 5;
const MAX_LOCATIONS = Number(process.env.MAX_LOCATIONS) || 0;
const LOCATION_POSTCODES = String(process.env.LOCATION_POSTCODES || '')
  .split(',')
  .map(value => value.trim().toUpperCase())
  .filter(Boolean);
const DEBUG_DIR = path.join(__dirname, '..', '..', 'debug');

function log(scope, message) {
  console.log(`[${scope}] ${message}`);
}

function normalizePlatform(rawPlatform, url) {
  if (rawPlatform === 'idox') {
    const lower = String(url || '').toLowerCase();
    return lower.includes('publicaccess') ? 'public_access' : 'idox';
  }
  if (String(url || '').toLowerCase().includes('force.com') || String(url || '').toLowerCase().includes('.site.com')) {
    return 'salesforce';
  }
  return rawPlatform || 'unknown';
}

function mapApplicationForSupabase(app, location, platform) {
  const reference = app.application_reference || app.application_uid;
  const receivedAt = normalizeDate(app.received_date);
  const validatedAt = normalizeDate(app.validated_date);
  return {
    application_uid: `${location.postcode}:${reference}`,
    application_reference: reference,
    council: app.council_name || location.postcode || location.region,
    platform,
    address: app.address || null,
    proposal: app.proposal || null,
    status: app.status || null,
    source_url: app.source_url || null,
    documents_url: app.documents_url || null,
    received_at: receivedAt,
    validated_at: validatedAt,
    scrape_status: 'location_extracted',
  };
}

function normalizeDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text;
  const natural = text.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})$/i);
  if (natural) {
    const months = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const [, d, m, y] = natural;
    return `${y}-${months[m.slice(0, 3).toLowerCase()]}-${d.padStart(2, '0')}`;
  }
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!match) return null;
  const [, d, m, y] = match;
  const year = y.length === 2 ? `20${y}` : y;
  return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

async function saveFailureScreenshot(page, location, platform) {
  if (!page) return;
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const safe = `${location.postcode || 'location'}_${platform || 'unknown'}_${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    await page.screenshot({ path: path.join(DEBUG_DIR, `phase10_${safe}.png`), fullPage: true });
  } catch (err) {
    log('EXTRACT', `Could not save failure screenshot: ${err.message}`);
  }
}

async function extractForLocation(context, location) {
  log('LOCATION', `Processing ${location.postcode} (${location.region || 'unknown region'})`);
  log('LOCATION', `Source URL: ${location.source_url}`);

  const page = await context.newPage();
  const startedAt = Date.now();
  let platform = normalizePlatform(detectPlatform(location.source_url), location.source_url);
  log('PLATFORM', `Detected ${platform.toUpperCase()}`);

  try {
    let extracted = [];

    if (platform === 'idox' || platform === 'public_access') {
      const result = await scrapeIdoxApplications(page, location.source_url, location, MAX_APPLICATIONS_PER_LOCATION);
      extracted = result.applications || [];
      platform = normalizePlatform(detectPlatform(result.sourceUrl || location.source_url), result.sourceUrl || location.source_url);
    } else if (platform === 'salesforce' || platform === 'custom' || platform === 'unknown') {
      log('PLATFORM', `Unsupported portal for automated application extraction: ${platform}`);
      return { platform, found: 0, saved: 0, unsupported: 1, failed: 0 };
    }

    const rows = extracted.slice(0, MAX_APPLICATIONS_PER_LOCATION).map(app => mapApplicationForSupabase(app, location, platform));
    log('EXTRACT', `Found ${rows.length} applications`);

    if (rows.length === 0) {
      await saveFailureScreenshot(page, location, platform);
      return { platform, found: 0, saved: 0, unsupported: 0, failed: 1 };
    }

    const savedRows = await applicationsRepository.upsertApplications(rows);
    log('SUPABASE', `Upserted ${savedRows.length} records`);

    await recordPlatformMetric({
      url: location.source_url,
      platform,
      success: true,
      blocked: false,
      extractionCount: rows.length,
      responseMs: Date.now() - startedAt,
    }).catch(err => log('SUPABASE', `Platform metric skipped: ${err.message}`));

    return { platform, found: rows.length, saved: savedRows.length, unsupported: 0, failed: 0 };
  } catch (err) {
    await saveFailureScreenshot(page, location, platform);
    log('EXTRACT', `Failed ${location.postcode}: ${err.message}`);
    await recordPlatformMetric({
      url: location.source_url,
      platform,
      success: false,
      blocked: err.code === 'BLOCKED',
      extractionCount: 0,
      responseMs: Date.now() - startedAt,
    }).catch(metricErr => log('SUPABASE', `Platform metric skipped: ${metricErr.message}`));
    return { platform, found: 0, saved: 0, unsupported: 0, failed: 1, blocked: err.code === 'BLOCKED' ? 1 : 0 };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const startedAt = Date.now();
  const metrics = {
    locationsProcessed: 0,
    applicationsFound: 0,
    applicationsSaved: 0,
    failures: 0,
    unsupportedPortals: 0,
    blockedRequests: 0,
  };

  const run = await runsRepository.startRun({ run_status: 'location_extraction_running' }).catch(err => {
    log('SUPABASE', `Run tracking unavailable: ${err.message}`);
    return null;
  });

  const allLocations = await postcodeAreasRepository.getExtractableLocations();
  const filteredLocations = LOCATION_POSTCODES.length > 0
    ? allLocations.filter(location => LOCATION_POSTCODES.includes(String(location.postcode || '').toUpperCase()))
    : allLocations;
  const locations = MAX_LOCATIONS > 0 ? filteredLocations.slice(0, MAX_LOCATIONS) : filteredLocations;
  log('LOCATION', `Loaded ${locations.length} extractable locations`);

  let context = null;
  try {
    context = await createBrowserContext({
      sessionId: 'phase10_locations',
      headless: process.env.HEADLESS === 'true',
    });

    for (const location of locations) {
      metrics.locationsProcessed++;
      const result = await extractForLocation(context, location);
      metrics.applicationsFound += result.found || 0;
      metrics.applicationsSaved += result.saved || 0;
      metrics.failures += result.failed || 0;
      metrics.unsupportedPortals += result.unsupported || 0;
      metrics.blockedRequests += result.blocked || 0;
    }
  } finally {
    if (context) await context.close().catch(() => {});
  }

  const runtimeSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(2));
  await runsRepository.completeRun(run && run.id, {
    totalApplications: metrics.applicationsSaved,
    totalDocuments: 0,
    blockedRequests: metrics.blockedRequests,
    runtimeSeconds,
    run_status: metrics.failures > 0 ? 'completed_with_failures' : 'completed',
  }).catch(err => log('SUPABASE', `Run completion skipped: ${err.message}`));

  log('EXTRACT', `Complete locations=${metrics.locationsProcessed} found=${metrics.applicationsFound} saved=${metrics.applicationsSaved} failures=${metrics.failures} unsupported=${metrics.unsupportedPortals}`);
}

main().catch(err => {
  log('EXTRACT', `Fatal: ${err.message}`);
  process.exit(1);
});
