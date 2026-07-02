/**
 * index.js — Main orchestrator with centralized reliability reporting.
 *
 * Flow:
 *   Planit API (JSON) → Resume Check → Detect platform → Run adapter (Playwright)
 *   → Real-time Streaming Downloads → Save JSON → Finalize Run Summary
 */

// Load environmental variables from .env
require('dotenv').config();


const fs = require('fs');
const path = require('path');
const { createBrowser } = require('./browser');
const { getApplications } = require('./planit');
const { detectPlatform, routeAdapter } = require('./detector');
const { scrapeIdoxDocuments } = require('./adapters/idox');
const { scrapeArcusDocuments } = require('./adapters/arcus');
const { scrapeSalesforceDocuments } = require('./adapters/salesforce');
const { scrapeGenericDocuments } = require('./adapters/generic');
const { scrapeCapitaDocuments } = require('./adapters/capita-planning-case');
const { downloadDocument } = require('./download/downloadManager');
const { RunManager } = require('./core/runManager');
const { loadFilter, shouldProcess } = require('./core/postcodeFilter');
const { resolveDateRange } = require('./utils/dateValidation');
const applicationsRepository = require('./db/repositories/applicationsRepository');
const documentsRepository = require('./db/repositories/documentsRepository');
const runsRepository = require('./db/repositories/runsRepository');
const { recordPlatformMetric } = require('./platforms/fingerprint');
const runLogger = require('./logging/runLogger');
const { documentReason, metadataReason } = require('./logging/reasonCodes');

// Adapters that run through a Playwright browser context (so downloads can
// reuse the session). Checked against the ROUTED adapter, not the raw platform.
const BROWSER_PLATFORMS = ['idox', 'arcus', 'salesforce', 'generic'];

// ── Generic harvester gating (opt-in for first ship) ───────────────────────────
// GENERIC_ENABLED=true runs the generic harvester for ALL non-adapter councils.
// GENERIC_COUNCILS=Wandsworth,Birmingham enables it for just those (case-
// insensitive, matched on app.area) even when GENERIC_ENABLED is false.
// DISABLE_FIELD_SUPPLEMENT is RESERVED for a future adapter field-supplement pass
// and is intentionally not wired this ship (generic extracts its own fields).
const GENERIC_ENABLED = String(process.env.GENERIC_ENABLED || '').toLowerCase() === 'true';
const GENERIC_COUNCILS = String(process.env.GENERIC_COUNCILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function isGenericEnabledFor(council) {
  if (GENERIC_ENABLED) return true;
  if (!council) return false;
  return GENERIC_COUNCILS.includes(String(council).toLowerCase());
}

// True when a URL's PATH (not a bare substring of the whole URL) is the Capita
// Planning Case comments endpoint. Parsing the URL means a query string that merely
// mentions the path can't trigger a false capita route. Used by the routing
// override below. String/path analysis only — no council names anywhere.
function isCapitaCommentsUrl(u) {
  if (!u) return false;
  try {
    return /\/planningcase\/comments\.aspx$/i.test(new URL(u).pathname);
  } catch {
    return false; // unparseable URL → not capita
  }
}

// Adapter-extracted metadata → application columns. Every active adapter now
// returns a `metadata` object (Idox Details tab, Northgate detail page, Arcus/
// Salesforce APIs). We map ONLY the non-empty fields so the upsert spread never
// clobbers a previously-good value with null. Adapter keys use the *_name suffix
// convention (applicant_name/agent_name) established by the Capita adapter.
function adapterContacts(docsObject) {
  const md = docsObject && docsObject.metadata;
  const out = {};
  if (!md) return out;
  const setIf = (col, val) => {
    if (val !== null && val !== undefined && String(val).trim() !== '') out[col] = val;
  };
  setIf('applicant', md.applicant_name);
  setIf('agent', md.agent_name);
  setIf('case_officer', md.case_officer);
  setIf('agent_company', md.agent_company);
  setIf('agent_address', md.agent_address);
  setIf('decision', md.decision);
  setIf('target_decision_date', md.target_decision_date);
  setIf('consultation_start_date', md.consultation_start_date);
  return out;
}

// ── CONFIG & ENV ──────────────────────────────────────────────────────────────
// LOCATION maps to Planit's `auth` filter, which expects a COUNCIL/authority key
// (e.g. "Croydon", "Camden"), NOT a region like "London". An empty LOCATION means
// no `auth` filter at all → the national recent-applications feed. See
// src/planit.js fetchApplicationList(): `auth` is only appended when areaName is set.
const LOCATION = process.env.LOCATION || '';
const OUTPUT_FILE = path.join(__dirname, '..', 'output', 'results.json');
const DAYS_TO_FETCH = Number(process.env.DAYS_TO_FETCH) || 4;
const MAX_APPLICATIONS = Number(process.env.MAX_APPLICATIONS) || 5;
// Optional absolute date-range window (YYYY-MM-DD). When either is set, the Planit
// feed uses start_date__gte/__lte instead of the rolling `recent` window. See
// src/utils/dateValidation.js for the resolution rules.
const START_DATE = process.env.START_DATE || '';
const END_DATE = process.env.END_DATE || '';

/**
 * Folds Planit detail metadata (app.planitMetadata) into the fields the
 * applications repository maps to columns. Returns a shallow copy of `app` with
 * the mapped fields ADDED only when planitMetadata holds a non-null value — it
 * never overwrites an existing value with null. Platform-agnostic: runs before
 * any adapter is chosen, so every platform benefits.
 *
 * Available in planitMetadata but STILL NOT stored (no column on `applications`):
 *   location_x, location_y, app_size, app_state, app_type, consulted_date,
 *   start_date, case_officer.
 * Left unmapped intentionally — decide later whether to add columns for them.
 */
function applyPlanitMetadata(app) {
  const m = app && app.planitMetadata;
  if (!m) return app;
  const out = { ...app };
  const setIf = (key, value) => { if (value !== null && value !== undefined) out[key] = value; };

  setIf('application_type', m.application_type);
  setIf('status', m.status);
  setIf('received_at', m.date_received);
  setIf('validated_at', m.date_validated);
  setIf('decision_date', m.decided_date);
  // `decided_by` (WHO decided: "Delegated", "Committee") now has its OWN column —
  // we no longer overload `decision` with it. `decision` is left for the actual
  // approval OUTCOME (Approved/Refused/Pending), to be populated by later work.
  setIf('decided_by', m.decided_by);
  // proposal: only fill from Planit description if nothing came from the listing.
  if ((out.proposal == null || out.proposal === '') && (out.description == null || out.description === '')) {
    setIf('proposal', m.description);
  }
  // applicant/agent: usually null due to the "See source" sentinel filter — that's
  // correct; the council portal scrape can populate them later.
  setIf('applicant', m.applicant_name);
  setIf('agent', m.agent_name);

  // Extended Planit metadata → their own columns (migration 004). Counts (0) are
  // preserved because setIf only skips null/undefined, not 0.
  setIf('postcode', m.postcode);
  setIf('ward_name', m.ward_name);
  setIf('uprn', m.uprn);
  setIf('planning_portal_id', m.planning_portal_id);
  setIf('lat', m.lat);
  setIf('lng', m.lng);
  setIf('easting', m.easting);
  setIf('northing', m.northing);
  setIf('n_statutory_days', m.n_statutory_days);
  setIf('n_documents', m.n_documents);
  setIf('n_constraints', m.n_constraints);
  setIf('n_comments', m.n_comments);
  setIf('agent_company', m.agent_company);
  setIf('agent_address', m.agent_address);
  setIf('target_decision_date', m.target_decision_date);
  setIf('consultation_start_date', m.consultation_start_date);
  setIf('comment_url', m.comment_url);
  setIf('map_url', m.map_url);

  return out;
}

async function main() {
  const runManager = new RunManager();
  runManager.log('=== Planning Scraper Operational Run ===');
  runManager.log(`Config: LOCATION="${LOCATION}", FETCH_DAYS=${DAYS_TO_FETCH}, LIMIT=${MAX_APPLICATIONS}`);

  // ── Structured run logging (migration 011). Additive: writes to scrape_runs /
  // scrape_events; never alters console output (mirror is opt-in via RUNLOGGER_CONSOLE).
  await runLogger.startRun({
    trigger: process.env.SCRAPER_TRIGGER || 'manual',
    configSnapshot: {
      LOCATION, DAYS_TO_FETCH, MAX_APPLICATIONS,
      START_DATE: START_DATE || null, END_DATE: END_DATE || null,
      GENERIC_ENABLED, GENERIC_COUNCILS,
    },
    scraperVersion: require('../package.json').version,
  });
  runLogger.info({ stage: 'run_start', message: 'Scraper run started' });

  // Flush + finalize buffered logs on Ctrl+C / termination (status='aborted').
  const onSignal = (sig, code) => {
    runLogger.warn({ stage: 'run_finish', message: `Received ${sig}, flushing logs and exiting` });
    runLogger.finishRun({ status: 'aborted' }).finally(() => process.exit(code));
  };
  process.once('SIGINT', () => onSignal('SIGINT', 130));
  process.once('SIGTERM', () => onSignal('SIGTERM', 143));

  // Per-council roll-up for run counters (ok/fail computed from real scrape outcomes,
  // not skips). councils_attempted increments on first sight of each council.
  const councilStats = new Map();
  const registerCouncil = (council) => {
    if (!councilStats.has(council)) {
      councilStats.set(council, { ok: 0, fail: 0 });
      runLogger.incrementCounter('councils_attempted');
      runLogger.info({ stage: 'council_start', council, message: 'Starting council' });
    }
    return councilStats.get(council);
  };
  let runFailed = false;
  let runError = null;

  // Resolve the feed window (rolling vs absolute date range). On a bad date config,
  // log a specific error and exit cleanly (exit 1) — no crash, nothing started yet.
  const dateResolution = resolveDateRange(START_DATE, END_DATE, DAYS_TO_FETCH);
  if (dateResolution.error) {
    runManager.log(`Invalid date configuration: ${dateResolution.error}`, 'ERROR');
    process.exit(1);
  }
  let dateRange = null;
  if (dateResolution.mode === 'range') {
    dateRange = dateResolution;
    runManager.log(`Mode: date range, ${dateResolution.startDate} to ${dateResolution.endDate}`);
    (dateResolution.warnings || []).forEach(w => runManager.log(w, 'WARNING'));
    if (process.env.DAYS_TO_FETCH) {
      runManager.log('DAYS_TO_FETCH is ignored when START_DATE/END_DATE are set (date range takes precedence)', 'WARNING');
    }
  } else {
    runManager.log(`Mode: rolling window, last ${DAYS_TO_FETCH} days`);
  }

  let results = [];
  let browser = null;
  let dbRun = null;

  try {
    dbRun = await runsRepository.startRun({ run_status: 'running' }).catch(err => {
      runManager.log(`Supabase run tracking unavailable: ${err.message}`, 'WARNING');
      return null;
    });

    // 1. Fetch from Planit API
    runManager.log('Fetching application feed from Planit JSON API...');
    const incomingApps = await getApplications(DAYS_TO_FETCH, MAX_APPLICATIONS, LOCATION, dateRange);
    runLogger.info({ stage: 'planit_fetch', message: 'Fetched batch from PlanIt', details: { count: incomingApps.length, location: LOCATION || 'all', dateRange: dateRange || null } });
    runLogger.incrementCounter('applications_seen', incomingApps.length);
    // Initial fetch: persist with the Planit detail metadata folded into columns.
    await applicationsRepository.upsertApplications(incomingApps.map(applyPlanitMetadata)).catch(err => {
      runManager.log(`Supabase application batch persistence failed: ${err.message}`, 'WARNING');
    });
    runManager.log(`Enriched applications returned from Planit: ${incomingApps.length}`);

    if (incomingApps.length === 0) {
      runManager.log('No applications found. Exiting.');
      if (!fs.existsSync(path.dirname(OUTPUT_FILE))) {
        fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
      }
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify([], null, 2));
      runManager.finalize();
      runLogger.info({ stage: 'run_finish', message: 'Scraper run completed (no applications)' });
      await runLogger.finishRun({ status: 'completed' });
      return;
    }

    // 1b. Load the service-provider postcode-area coverage filter (once).
    //     Applications are only processed if their postcode area is covered by
    //     at least one registered provider in sp_contact_profiles. Fail-closed.
    const postcodeFilter = await loadFilter();

    // 2. Filter queue with Resume Support
    const queue = runManager.getResumeQueue(incomingApps);

    // In-memory manifest only — used for intra-run SHA-256 dedup. Not persisted.
    let manifest = { generatedAt: new Date().toISOString(), files: [], metrics: {} };

    // 3. Process Applications
    for (const app of queue) {
      const councilName = app.area || 'Unknown';
      registerCouncil(councilName);
      const appStartedAt = Date.now();

      // ── Postcode-area coverage gate (applies to ALL adapters) ──────────────
      // Runs before resume-check / detectPlatform / status upsert so an
      // uncovered application never gets scraped or downloaded by any path.
      const decision = shouldProcess(app, postcodeFilter);
      if (!decision.allowed) {
        runManager.recordFilterSkip(app, decision.reason);
        runManager.log(`[filter] SKIP ${app.title}  (${decision.reason})`, 'WARNING');
        runLogger.info({ stage: 'postcode_skip', council: councilName, applicationUid: app.title, message: 'Skipped — outside postcode filter', details: { reason_code: 'skipped_postcode_filter', reason_message: decision.reason || 'Outside covered postcode areas', address: app.address || null } });
        runLogger.incrementCounter('applications_skipped_filter');
        await applicationsRepository.upsertApplication({ ...applyPlanitMetadata(app), scrape_status: 'skipped_filter' }).catch(err => {
          runManager.log(`Supabase application upsert failed for ${app.title}: ${err.message}`, 'WARNING');
        });
        // Auditable record in results.json — distinct platform + the reason.
        results.push({ ...app, platform: 'filtered', filter_reason: decision.reason, documents: [] });
        continue;
      }
      if (decision.matchedArea) {
        runManager.log(`[filter] PASS ${app.title}  (area: ${decision.matchedArea})`);
      }

      // ── Change-detection gate (migration 007) — BEFORE the resume fast-path ──
      // Read the existing row once. If it's terminal, skip the re-check entirely.
      // Otherwise gather the document URLs already in the DB so downloadManager can
      // skip re-downloading them (cross-run dedup). One findByUid + (when active)
      // one listDocuments per application — accepted cost.
      const existing = await applicationsRepository.findByUid(app.title).catch(() => null);
      let knownUrls = new Set();
      let recheckCount = 0;
      if (existing) {
        recheckCount = (existing.recheck_count || 0) + 1;
        // Skip ONLY a terminal application we have ALREADY scraped at least once
        // (recheck_count > 0). A first encounter — recheck_count === 0, even if the
        // status is already terminal (e.g. an old "FINAL DECISION" app surfaced by a
        // date-range backfill) — must still run the adapter so its documents get
        // fetched. recheck_count === 0 with is_terminal === true is also the
        // signature of the earlier first-encounter-skip bug, where the flag was set
        // from Planit status without ever scraping; we deliberately don't trust it.
        // Defensive: explicit === true (null/false/undefined all mean "active").
        if (existing.is_terminal === true && (existing.recheck_count || 0) > 0) {
          runManager.log(`Skipping terminal application: ${app.title} (status: ${existing.status || 'n/a'})`);
          runLogger.info({ stage: 'terminal_skip', council: councilName, applicationUid: app.title, message: 'Skipped — terminal state', details: { reason_code: 'skipped_terminal', reason_message: `Terminal status "${existing.status || 'n/a'}" already scraped (recheck_count=${existing.recheck_count || 0})`, status: existing.status || null, is_terminal: existing.is_terminal, recheck_count: existing.recheck_count } });
          runLogger.incrementCounter('applications_skipped_terminal');
          await applicationsRepository.upsertApplication(
            { ...applyPlanitMetadata(app), scrape_status: 'skipped_terminal' },
            { lastChecked: true, recheckCount, setTerminalFromStatus: true }
          ).catch(err => {
            runManager.log(`Supabase application upsert failed for ${app.title}: ${err.message}`, 'WARNING');
          });
          results.push({ ...app, platform: existing.platform || app.platform || 'unknown', scrape_status: 'skipped_terminal', documents: [] });
          continue;
        }
        const known = await documentsRepository.listDocuments({ applicationId: existing.id, pageSize: 1000 }).catch(() => ({ data: [] }));
        knownUrls = new Set((known.data || []).map(d => d.source_url).filter(Boolean));
        if (knownUrls.size > 0) {
          runManager.log(`[change] ${app.title}: ${knownUrls.size} known document URL(s) from prior runs (will skip re-download)`);
        }
      }

      runManager.log(`Processing application: ${app.title} (Council: ${app.area || 'Unknown'})`);
      // 'queued' is a thin pre-adapter marker: do NOT bump recheck_count here — that
      // would re-arm the terminal gate before we've secured any documents. The counter
      // is bumped by the post-scrape upsert (or the terminal-skip upsert) only.
      await applicationsRepository.upsertApplication({ ...applyPlanitMetadata(app), scrape_status: app.skipped_resume ? 'skipped_resume' : 'queued' }).catch(err => {
        runManager.log(`Supabase application upsert failed for ${app.title}: ${err.message}`, 'WARNING');
      });

      // If already processed and skipped by resume
      if (app.skipped_resume) {
        runManager.log(`Resume Support: Restoring existing record for ${app.title}`);
        results.push(app);

        // Fast-path download sync for resume items
        const docsList = Array.isArray(app.documents)
          ? app.documents
          : (app.documents && Array.isArray(app.documents.documents) ? app.documents.documents : []);

        for (const doc of docsList) {
          // Resume fast-path: no adapter/context here; pass knownUrls so docs
          // already persisted in a prior run are not re-downloaded.
          const downloadRecord = await downloadDocument(doc, app, app.area || 'Unknown', manifest, null, null, null, knownUrls);
          runManager.recordDownload(downloadRecord.status, downloadRecord.sizeBytes);
          if (downloadRecord.status === 'downloaded' || downloadRecord.status === 'downloaded_no_storage') runLogger.incrementCounter('documents_downloaded');
          else if (downloadRecord.status === 'skipped_known') runLogger.incrementCounter('documents_skipped_known');
          else if (downloadRecord.status === 'failed') runLogger.incrementCounter('documents_failed');
          const appRow = await applicationsRepository.findByUid(app.title).catch(() => null);
          await documentsRepository.upsertDocument({ ...doc, ...downloadRecord }, appRow && appRow.id).catch(err => {
            runManager.log(`Supabase resumed document persistence failed: ${err.message}`, 'WARNING');
          });

          // Keep manifest in memory updated
          manifest.files = manifest.files || [];
          if (!manifest.files.some(f => f.sourceUrl === downloadRecord.sourceUrl)) {
            manifest.files.push(downloadRecord);
          }
        }
        continue;
      }

      // Detect & route against the SOURCE/detail URL. docsUrl is council-published
      // and platform-inconsistent (e.g. Northgate councils publish a comments-page
      // URL there), so it must NOT drive detection/routing. Fall back to docsUrl
      // only when there is no source URL at all (so we don't drop those apps).
      const sourceUrl = app.sourceUrl || app.source_url || null;
      const detectUrl = sourceUrl || app.docsUrl;
      if (!detectUrl) {
        runManager.log(`Skipping ${app.title} — no valid scraper URL available`, 'WARNING');
        runLogger.warn({ stage: 'missing_url_skip', council: councilName, applicationUid: app.title, message: 'Skipped — no valid portal URL available', details: { reason_code: 'skipped_missing_url', reason_message: 'No source_url or docs_url from Planit' } });
        councilStats.get(councilName).fail++;
        results.push({
          ...app,
          platform: 'unknown',
          documents: []
        });
        runManager.recordApplication(app, 'unknown', false, new Error('No valid portal URL available'), 0);
        await applicationsRepository.upsertApplication({ ...applyPlanitMetadata(app), platform: 'unknown', scrape_status: 'missing_url' }).catch(() => {});
        continue;
      }

      const platform = detectPlatform(detectUrl);
      let adapter = routeAdapter(detectUrl);
      // Navigation target: keep Idox's working docs-tab path (docsUrl when present);
      // every other adapter (Arcus/Salesforce/Generic) navigates the source/detail
      // URL, never the council-published docsUrl.
      let scrapeUrl = (adapter === 'idox')
        ? (app.docsUrl || sourceUrl || detectUrl)
        : (sourceUrl || detectUrl);

      /*
       * Capita routing override:
       * routeAdapter() takes a single URL. For Wandsworth and similar councils,
       * Planit gives us sourceUrl (Northgate detail page on planning.{council}) and
       * docsUrl (Capita comments page on planning2.{council}). routeAdapter(sourceUrl)
       * returns 'generic' because it can't see docsUrl.
       *
       * This override checks BOTH URLs for the Capita pattern and upgrades a
       * would-be 'generic' route to 'capita'. It only ever REPLACES generic — never
       * overrides Idox/Arcus/Salesforce (guarded by `adapter === 'generic'`).
       *
       * Northgate-detail-only councils (where Planit doesn't include the comments URL
       * in either field) still fall to generic. Generic records the cross-domain link
       * in crossDomainDocLinks as telemetry for a future auto-defer (Phase 5).
       *
       * Match is by URL PATHNAME (parsed), not a bare substring, so a stray query
       * string mentioning the path can't trigger a false route. No per-council code.
       */
      if (adapter === 'generic') {
        const capitaUrl = [sourceUrl, app.docsUrl].find(isCapitaCommentsUrl);
        if (capitaUrl) { adapter = 'capita'; scrapeUrl = capitaUrl; }
      }
      runManager.log(`Detected Platform: ${platform.toUpperCase()} (adapter: ${adapter}) for ${scrapeUrl}`);
      runManager.log(`[diag] URL resolution: app.sourceUrl=${app.sourceUrl} app.docsUrl=${app.docsUrl} resolved sourceUrl=${sourceUrl} detectUrl=${detectUrl} scrapeUrl=${scrapeUrl} platform=${platform} adapter=${adapter}`);
      runLogger.info({ stage: 'application_start', council: councilName, applicationUid: app.title, adapter, message: 'Processing application', details: { platform, scrapeUrl } });

      // Generic harvester is opt-in (first ship). If a council routes to generic
      // but generic isn't enabled for it, record 'generic_disabled' (we CHOSE not
      // to attempt — distinct from 'failed') and move on. No browser, no failure.
      if (adapter === 'generic' && !isGenericEnabledFor(app.area)) {
        runManager.log(`Generic harvester disabled for council "${app.area}" — set GENERIC_ENABLED=true or add it to GENERIC_COUNCILS to attempt it.`, 'WARNING');
        runLogger.info({ stage: 'generic_disabled', council: councilName, applicationUid: app.title, adapter, message: 'Skipped — generic harvester disabled for this council', details: { reason_code: 'skipped_generic_disabled', reason_message: 'Generic harvester not enabled for this council (GENERIC_ENABLED / GENERIC_COUNCILS)' } });
        results.push({ ...app, platform, documentsCount: 0, documents: [] });
        await applicationsRepository.upsertApplication({ ...applyPlanitMetadata(app), platform, scrape_status: 'generic_disabled' }).catch(err => {
          runManager.log(`Supabase application upsert failed for ${app.title}: ${err.message}`, 'WARNING');
        });
        continue;
      }

      let docsObject = { documents: [], metrics: {} };
      let success = false;
      let error = null;
      let context = null;
      let sourcePage = null;

      runLogger.info({ stage: 'adapter_start', council: councilName, applicationUid: app.title, adapter, message: 'Adapter invoked' });

      if (adapter === 'idox') {
        // Lazily initialize browser to conserve assets
        if (!browser) {
          runManager.log('Initializing Playwright browser context...');
          browser = await createBrowser();
        }

        context = await browser.newContext({ ignoreHTTPSErrors: true });
        sourcePage = await context.newPage();

        try {
          // Set custom timeouts if configured
          if (process.env.TIMEOUT) {
            sourcePage.setDefaultTimeout(Number(process.env.TIMEOUT));
          }

          docsObject = await scrapeIdoxDocuments(sourcePage, scrapeUrl);
          success = docsObject.metrics && docsObject.metrics.success;
        } catch (err) {
          error = err;
          success = false;
          runManager.log(`Playwright Portal extraction crash: ${err.message}`, 'ERROR');
        }

      } else if (adapter === 'arcus') {
        if (!browser) {
          runManager.log('Initializing Playwright browser context...');
          browser = await createBrowser();
        }
        context = await browser.newContext({ ignoreHTTPSErrors: true });
        sourcePage = await context.newPage();
        try {
          docsObject = await scrapeArcusDocuments(sourcePage, scrapeUrl);
          success = docsObject.metrics && docsObject.metrics.success;
        } catch (err) {
          error = err;
          success = false;
          runManager.log(`Arcus extraction error: ${err.message}`, 'ERROR');
        }

      } else if (adapter === 'salesforce') {
        if (!browser) {
          runManager.log('Initializing Playwright browser context...');
          browser = await createBrowser();
        }
        context = await browser.newContext({ ignoreHTTPSErrors: true });
        sourcePage = await context.newPage();
        try {
          docsObject = await scrapeSalesforceDocuments(sourcePage, scrapeUrl);
          success = docsObject.metrics && docsObject.metrics.success;
        } catch (err) {
          error = err;
          success = false;
          runManager.log(`Salesforce extraction error: ${err.message}`, 'ERROR');
        }

      } else if (adapter === 'capita') {
        // First NO-Playwright adapter: pure HTTP, no browser/context. The download
        // loop passes context=null because 'capita' is not in BROWSER_PLATFORMS.
        try {
          docsObject = await scrapeCapitaDocuments(app, scrapeUrl);
          success = docsObject.metrics && docsObject.metrics.success;
        } catch (err) {
          error = err;
          success = false;
          runManager.log(`Capita extraction error: ${err.message}`, 'ERROR');
        }

      } else if (adapter === 'generic') {
        if (!browser) {
          runManager.log('Initializing Playwright browser context...');
          browser = await createBrowser();
        }
        // Fresh context per application (anti-bot session isolation — a challenge
        // on one council must not carry its signal to the next).
        context = await browser.newContext({ ignoreHTTPSErrors: true });
        sourcePage = await context.newPage();
        if (process.env.TIMEOUT) sourcePage.setDefaultTimeout(Number(process.env.TIMEOUT));
        try {
          docsObject = await scrapeGenericDocuments(sourcePage, app, context, scrapeUrl);
          success = docsObject.extractionConfidence !== 'failed';
        } catch (err) {
          error = err;
          success = false;
          runManager.log(`Generic extraction error: ${err.message}`, 'ERROR');
        }

      } else {
        runManager.log(`Skipping extraction — unsupported platform: "${platform}"`, 'WARNING');
        error = new Error(`Unsupported platform: ${platform}`);
      }

      const documents = docsObject.documents || [];
      // Adapter-declared per-request auth (headers/cookies) for downloads. Idox
      // omits it; Arcus/Salesforce populate it. Never log its contents (secrets).
      const downloadAuth = docsObject.downloadAuth || undefined;

      // Adapter result events. Metadata (contact fields) is best-effort — record which
      // fields were captured; on hard failure this is 'warn', never a throw.
      const md = docsObject.metadata || null;
      const metaReason = metadataReason(md); // { reason_code, reason_message, fields_captured/attempted/null }
      const fieldsCaptured = metaReason.fields_captured;
      runLogger.event({
        level: (success || !error) ? 'info' : 'warn',
        stage: 'adapter_metadata', council: councilName, applicationUid: app.title, adapter,
        message: md ? `Metadata extracted (${fieldsCaptured.length} field(s))` : 'No metadata returned by adapter',
        details: metaReason,
      });
      runLogger.info({
        stage: 'adapter_documents', council: councilName, applicationUid: app.title, adapter,
        message: `Documents listed: ${documents.length}`,
        details: { doc_count: documents.length, scrape_status_hint: docsObject.scrapeStatusHint || null },
      });

      // Diagnostic: on any failure, surface WHAT actually went wrong. recordApplication
      // logs "Error: Unknown, Class: UNKNOWN" whenever `error` is null — which is the
      // SOFT-FAILURE case: the adapter returned metrics.success=false without throwing
      // (no exception ever reached the dispatch catch). Distinguish the two and dump
      // the real message/name/stack when an exception exists. Logging only — no control
      // flow change.
      if (!success) {
        if (error) {
          const stackTop = (error.stack || '').split('\n').slice(0, 4).join('\n');
          runManager.log(
            `Failure detail for ${app.title} (${platform}/${adapter}):\n` +
            `  Error message: ${error.message}\n` +
            `  Error type: ${error.name || (error.constructor && error.constructor.name) || 'Error'}\n` +
            `  Stack (top):\n${stackTop}`,
            'WARNING'
          );
        } else {
          // No exception was thrown — the adapter completed but declared failure.
          const m = docsObject.metrics || {};
          runManager.log(
            `Failure detail for ${app.title} (${platform}/${adapter}): SOFT FAILURE — ` +
            `adapter returned success=false with no exception thrown. ` +
            `metrics: totalRows=${m.totalRows ?? 'n/a'} validDocs=${m.validDocs ?? 'n/a'} ` +
            `runtimeMs=${m.runtimeMs ?? 'n/a'} scrapeStatusHint=${docsObject.scrapeStatusHint || 'none'}`,
            'WARNING'
          );
        }
      }

      runManager.recordApplication(app, platform, success, error, documents.length);

      // ── Document change detection (migration 007) ────────────────────────────
      // Compare the adapter's discovered URLs against the URLs already in the DB
      // (knownUrls, gathered above). Counts only in the log — never the URLs.
      const adapterUrls = new Set(documents.map(d => d.url).filter(Boolean));
      const newUrls = [...adapterUrls].filter(u => !knownUrls.has(u));
      const missingUrls = [...knownUrls].filter(u => !adapterUrls.has(u)); // Phase 5: mark removed
      const documentsChanged = newUrls.length > 0 || missingUrls.length > 0;
      runManager.log(`[change] ${app.title}: +${newUrls.length} -${missingUrls.length}`);

      // Final scrape_status. Generic and capita surface their own statuses (a
      // scrapeStatusHint: blocked_anti_bot / timeout / portal_unreachable /
      // requires_auth / requires_different_path / no_documents).
      let scrapeStatus;
      if (adapter === 'generic') {
        scrapeStatus = docsObject.scrapeStatusHint || (success ? 'generic_scraped' : 'failed');
      } else if (adapter === 'capita') {
        scrapeStatus = docsObject.scrapeStatusHint || (success ? 'scraped' : 'failed');
      } else {
        scrapeStatus = success ? 'scraped' : (error && error.code === 'BLOCKED' ? 'blocked' : 'failed');
      }

      // Post-scrape: we've done real work, so this is the ONE place that both bumps
      // recheck_count and derives the durable is_terminal from the live status
      // (setTerminalFromStatus). No other pre-adapter/thin path may set is_terminal.
      await applicationsRepository.upsertApplication({
        ...applyPlanitMetadata(app),
        ...adapterContacts(docsObject), // adapter contacts win over Planit; only the 3 non-null contact keys
        platform,
        scrape_status: scrapeStatus,
      }, { lastChecked: true, documentsChanged, recheckCount, setTerminalFromStatus: true }).catch(err => {
        runManager.log(`Supabase scrape status persistence failed for ${app.title}: ${err.message}`, 'WARNING');
      });
      await recordPlatformMetric({
        url: scrapeUrl,
        platform,
        success,
        blocked: Boolean(error && error.code === 'BLOCKED'),
        extractionCount: documents.length,
        responseMs: docsObject.metrics && docsObject.metrics.runtimeMs,
      }).catch(err => {
        runManager.log(`Supabase platform metric persistence failed: ${err.message}`, 'WARNING');
      });

      // 4. Download extracted files in real-time
      const processedDocs = [];
      let appDownloaded = 0;
      if (success && documents.length > 0) {
        runManager.log(`Initiating stream downloads for ${documents.length} extracted files... (downloadAuth: ${downloadAuth ? 'present' : 'absent'})`);
        for (const doc of documents) {
          // Pass the context to downloadDocument to preserve session cookies, plus
          // any adapter-declared downloadAuth and the adapter name (extraction_method).
          const docStartedAt = Date.now();
          const downloadRecord = await downloadDocument(doc, app, app.area || 'Unknown', manifest, BROWSER_PLATFORMS.includes(adapter) ? context : null, downloadAuth, adapter, knownUrls);
          const docDurationMs = Date.now() - docStartedAt;
          runManager.recordDownload(downloadRecord.status, downloadRecord.sizeBytes);
          if (downloadRecord.status === 'downloaded' || downloadRecord.status === 'downloaded_no_storage') appDownloaded++;
          // Structured per-document event: reason_code + labeled fields (see reasonCodes.js).
          const dlStatus = downloadRecord.status;
          const reason = documentReason(downloadRecord);
          const dlDetails = {
            ...reason,
            status: dlStatus,
            doc_name: doc.name || null,
            doc_url: doc.url || null,
            bytes: downloadRecord.sizeBytes || null,
            storage_path: downloadRecord.storagePath || null,
            duration_ms: docDurationMs,
          };
          if (dlStatus === 'downloaded' || dlStatus === 'downloaded_no_storage') {
            runLogger.info({ stage: 'document_download', council: councilName, applicationUid: app.title, adapter, message: `Document downloaded (${reason.reason_code})`, details: dlDetails, durationMs: docDurationMs });
            runLogger.incrementCounter('documents_downloaded');
          } else if (dlStatus === 'skipped_known' || dlStatus === 'skipped_duplicate') {
            runLogger.info({ stage: 'document_download', council: councilName, applicationUid: app.title, adapter, message: `Document skipped (${reason.reason_code})`, details: dlDetails, durationMs: docDurationMs });
            if (dlStatus === 'skipped_known') runLogger.incrementCounter('documents_skipped_known');
          } else if (dlStatus === 'failed') {
            runLogger.error({ stage: 'document_download', council: councilName, applicationUid: app.title, adapter, message: `Document download failed (${reason.reason_code}): ${downloadRecord.error || 'unknown'}`, details: dlDetails, durationMs: docDurationMs });
            runLogger.incrementCounter('documents_failed');
          }
          const appRow = await applicationsRepository.findByUid(app.title).catch(() => null);
          await documentsRepository.upsertDocument({ ...doc, ...downloadRecord }, appRow && appRow.id).catch(err => {
            runManager.log(`Supabase document persistence failed for ${doc.name}: ${err.message}`, 'WARNING');
          });

          manifest.files = manifest.files || [];
          if (!manifest.files.some(f => f.sourceUrl === downloadRecord.sourceUrl)) {
            manifest.files.push(downloadRecord);
          }

          // Save original doc reference
          processedDocs.push(doc);
        }
      }

      // Generic: final confidence for visibility (counts only — never names).
      // 'high' needs ≥1 field AND ≥1 doc actually downloaded; download success is
      // only known here (the adapter returns a discovery estimate).
      if (adapter === 'generic') {
        const f = (docsObject.metrics && docsObject.metrics.fieldsExtracted) || 0;
        const finalConfidence = (error || docsObject.scrapeStatusHint) ? 'failed'
          : (f > 0 && appDownloaded > 0) ? 'high'
          : (f > 0 || appDownloaded > 0) ? 'medium'
          : (documents.length > 0) ? 'low' : 'failed';
        runManager.log(`[generic] ${app.area} ${app.title}: status=${scrapeStatus} fields=${f} docs_found=${documents.length} docs_downloaded=${appDownloaded} confidence=${finalConfidence}`);
      }

      // Close the page and context after downloads are complete
      if (BROWSER_PLATFORMS.includes(adapter) && context) {
        try {
           const pages = context.pages();
           for (const p of pages) { await p.close(); }
           await context.close();
        } catch (e) {
           runManager.log(`Failed to close context: ${e.message}`);
        }
      }

      // ── Application outcome → run counters + structured event ────────────────
      const appDurationMs = Date.now() - appStartedAt;
      if (success) {
        councilStats.get(councilName).ok++;
        runLogger.incrementCounter('applications_scraped_ok');
        if (documents.length === 0) runLogger.incrementCounter('applications_skipped_no_docs');
        runLogger.info({
          stage: 'application_finish', council: councilName, applicationUid: app.title, adapter,
          message: 'Application scraped successfully',
          details: { reason_code: documents.length === 0 ? 'scraped_no_docs' : 'scraped_ok', reason_message: `${scrapeStatus} — ${documents.length} doc(s) found, ${appDownloaded} downloaded`, docs_found: documents.length, docs_downloaded: appDownloaded, contact_fields_captured: fieldsCaptured, scrape_status: scrapeStatus },
          durationMs: appDurationMs,
        });
      } else {
        councilStats.get(councilName).fail++;
        runLogger.incrementCounter('applications_scraped_failed');
        const failReason = (error && error.code === 'BLOCKED') ? 'blocked'
          : error ? 'adapter_error'
          : docsObject.scrapeStatusHint ? `failed_${docsObject.scrapeStatusHint}`
          : 'soft_failure';
        runLogger.error({
          stage: 'application_finish', council: councilName, applicationUid: app.title, adapter,
          message: `Application scrape failed: ${error ? error.message : (docsObject.scrapeStatusHint || 'soft failure')}`,
          details: { reason_code: failReason, reason_message: error ? error.message : (docsObject.scrapeStatusHint || 'adapter returned success=false without throwing'), scrape_status: scrapeStatus, error_type: error ? (error.name || 'Error') : null, error_message: error ? error.message : null, error_stack: error ? (error.stack || '').split('\n').slice(0, 6).join('\n') : null },
          durationMs: appDurationMs,
        });
      }

      results.push({
        title: app.title,
        area: app.area,
        address: app.address,
        description: app.description,
        startDate: app.startDate,
        planitUrl: app.planitUrl,
        sourceUrl: app.sourceUrl,
        docsUrl: app.docsUrl,
        platform,
        documentsCount: processedDocs.length,
        expectedDocumentsCount: app.nDocuments || app.expectedDocumentsCount || 0,
        documents: processedDocs
      });

      // Cool-down delay between portal connections
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Storage-only pipeline: the download manifest is kept in memory for
    // intra-run dedup only and is no longer persisted to disk.

  } catch (err) {
    runManager.log(`Orchestration loop failure: ${err.message}`, 'ERROR');
    runFailed = true;
    runError = err;
    runLogger.error({ stage: 'run_finish', message: `Fatal error: ${err.message}`, details: { stack: (err.stack || '').split('\n').slice(0, 8).join('\n') } });
  } finally {
    if (browser) {
      runManager.log('Closing Playwright browser context.');
      await browser.close();
    }
  }

  // 5. Save results and finalize metrics
  try {
    const dir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    runManager.log(`Saved ${results.length} application records to: ${OUTPUT_FILE}`);
  } catch (err) {
    runManager.log(`Failed writing results JSON: ${err.message}`, 'ERROR');
  }

  // Generate final statistics
  const finalSummary = runManager.finalize();
  if (dbRun && dbRun.id) {
    await runsRepository.completeRun(dbRun.id, {
      totalApplications: finalSummary.summary.totalProcessed,
      totalDocuments: finalSummary.summary.documentsExtracted,
      successfulDownloads: finalSummary.summary.downloadsCompleted,
      // Real per-document download failure count (no longer derived from
      // application-level error categories, which conflated different failures).
      failedDownloads: finalSummary.summary.downloadsFailed,
      blockedRequests: finalSummary.errorClassification && finalSummary.errorClassification.BLOCKED || 0,
      runtimeSeconds: finalSummary.runtimeMs / 1000,
      run_status: 'completed',
    }).catch(err => {
      runManager.log(`Supabase run completion persistence failed: ${err.message}`, 'WARNING');
    });
  }

  // ── Finalize structured run logging ──────────────────────────────────────────
  // Council roll-up: succeeded = ≥1 app scraped ok; failed = ≥1 failed AND 0 ok.
  // Councils with only skips (terminal/filter) count as neither.
  for (const stats of councilStats.values()) {
    if (stats.ok > 0) runLogger.incrementCounter('councils_succeeded');
    else if (stats.fail > 0) runLogger.incrementCounter('councils_failed');
  }
  const finalStatus = runFailed
    ? 'failed'
    : (runLogger.counters && (runLogger.counters.applications_scraped_failed > 0 || runLogger.counters.councils_failed > 0) ? 'partial' : 'completed');
  runLogger.info({ stage: 'run_finish', message: `Scraper run finished (status=${finalStatus})` });
  await runLogger.finishRun({ status: finalStatus, errorSummary: runError ? runError.message : null });
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal crash in main thread:', err);
    process.exit(1);
  });
}

module.exports = { main };