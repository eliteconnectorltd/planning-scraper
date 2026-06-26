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
const { downloadDocument } = require('./download/downloadManager');
const { RunManager } = require('./core/runManager');
const { loadFilter, shouldProcess } = require('./core/postcodeFilter');
const applicationsRepository = require('./db/repositories/applicationsRepository');
const documentsRepository = require('./db/repositories/documentsRepository');
const runsRepository = require('./db/repositories/runsRepository');
const { recordPlatformMetric } = require('./platforms/fingerprint');

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

// Adapter-extracted contact fields (generic only, for now). Returns ONLY the
// three non-null contact columns so the upsert spread can't clobber anything else.
function adapterContacts(docsObject) {
  const md = docsObject && docsObject.metadata;
  const out = {};
  if (!md) return out;
  if (md.applicant_name) out.applicant = md.applicant_name;
  if (md.agent_name) out.agent = md.agent_name;
  if (md.case_officer) out.case_officer = md.case_officer;
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
    const incomingApps = await getApplications(DAYS_TO_FETCH, MAX_APPLICATIONS, LOCATION);
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
      // ── Postcode-area coverage gate (applies to ALL adapters) ──────────────
      // Runs before resume-check / detectPlatform / status upsert so an
      // uncovered application never gets scraped or downloaded by any path.
      const decision = shouldProcess(app, postcodeFilter);
      if (!decision.allowed) {
        runManager.recordFilterSkip(app, decision.reason);
        runManager.log(`[filter] SKIP ${app.title}  (${decision.reason})`, 'WARNING');
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

      runManager.log(`Processing application: ${app.title} (Council: ${app.area || 'Unknown'})`);
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
          const downloadRecord = await downloadDocument(doc, app, app.area || 'Unknown', manifest);
          runManager.recordDownload(downloadRecord.status, downloadRecord.sizeBytes);
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
      const adapter = routeAdapter(detectUrl);
      // Navigation target: keep Idox's working docs-tab path (docsUrl when present);
      // every other adapter (Arcus/Salesforce/Generic) navigates the source/detail
      // URL, never the council-published docsUrl.
      const scrapeUrl = (adapter === 'idox')
        ? (app.docsUrl || sourceUrl || detectUrl)
        : (sourceUrl || detectUrl);
      runManager.log(`Detected Platform: ${platform.toUpperCase()} (adapter: ${adapter}) for ${scrapeUrl}`);
      runManager.log(`[diag] URL resolution: app.sourceUrl=${app.sourceUrl} app.docsUrl=${app.docsUrl} resolved sourceUrl=${sourceUrl} detectUrl=${detectUrl} scrapeUrl=${scrapeUrl} platform=${platform} adapter=${adapter}`);

      // Generic harvester is opt-in (first ship). If a council routes to generic
      // but generic isn't enabled for it, record 'generic_disabled' (we CHOSE not
      // to attempt — distinct from 'failed') and move on. No browser, no failure.
      if (adapter === 'generic' && !isGenericEnabledFor(app.area)) {
        runManager.log(`Generic harvester disabled for council "${app.area}" — set GENERIC_ENABLED=true or add it to GENERIC_COUNCILS to attempt it.`, 'WARNING');
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
      runManager.recordApplication(app, platform, success, error, documents.length);

      // Final scrape_status. Generic surfaces its own statuses (generic_scraped, or
      // a terminal hint: blocked_anti_bot / timeout / portal_unreachable / requires_auth).
      let scrapeStatus;
      if (adapter === 'generic') {
        scrapeStatus = docsObject.scrapeStatusHint || (success ? 'generic_scraped' : 'failed');
      } else {
        scrapeStatus = success ? 'scraped' : (error && error.code === 'BLOCKED' ? 'blocked' : 'failed');
      }

      await applicationsRepository.upsertApplication({
        ...applyPlanitMetadata(app),
        ...adapterContacts(docsObject), // adapter contacts win over Planit; only the 3 non-null contact keys
        platform,
        scrape_status: scrapeStatus,
      }).catch(err => {
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
          const downloadRecord = await downloadDocument(doc, app, app.area || 'Unknown', manifest, BROWSER_PLATFORMS.includes(adapter) ? context : null, downloadAuth, adapter);
          runManager.recordDownload(downloadRecord.status, downloadRecord.sizeBytes);
          if (downloadRecord.status === 'downloaded' || downloadRecord.status === 'downloaded_no_storage') appDownloaded++;
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
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal crash in main thread:', err);
    process.exit(1);
  });
}

module.exports = { main };