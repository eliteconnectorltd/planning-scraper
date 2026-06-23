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
const { detectPlatform } = require('./detector');
const { scrapeIdoxDocuments } = require('./adapters/idox');
const { scrapeArcusDocuments } = require('./adapters/arcus');
const { scrapeSalesforceDocuments } = require('./adapters/salesforce');
const { downloadDocument } = require('./download/downloadManager');
const { RunManager } = require('./core/runManager');
const applicationsRepository = require('./db/repositories/applicationsRepository');
const documentsRepository = require('./db/repositories/documentsRepository');
const runsRepository = require('./db/repositories/runsRepository');
const { recordPlatformMetric } = require('./platforms/fingerprint');

// Platforms that run through a Playwright browser context (so downloads can
// reuse the session). All current adapters use the context.
const BROWSER_PLATFORMS = ['idox', 'arcus', 'salesforce'];

// ── CONFIG & ENV ──────────────────────────────────────────────────────────────
const LOCATION = process.env.LOCATION || 'London';
const OUTPUT_FILE = path.join(__dirname, '..', 'output', 'results.json');
const DAYS_TO_FETCH = Number(process.env.DAYS_TO_FETCH) || 4;
const MAX_APPLICATIONS = Number(process.env.MAX_APPLICATIONS) || 5;

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
    await applicationsRepository.upsertApplications(incomingApps).catch(err => {
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

    // 2. Filter queue with Resume Support
    const queue = runManager.getResumeQueue(incomingApps);

    // In-memory manifest only — used for intra-run SHA-256 dedup. Not persisted.
    let manifest = { generatedAt: new Date().toISOString(), files: [], metrics: {} };

    // 3. Process Applications
    for (const app of queue) {
      runManager.log(`Processing application: ${app.title} (Council: ${app.area || 'Unknown'})`);
      await applicationsRepository.upsertApplication({ ...app, scrape_status: app.skipped_resume ? 'skipped_resume' : 'queued' }).catch(err => {
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

      const scrapeUrl = app.docsUrl || app.sourceUrl;
      if (!scrapeUrl) {
        runManager.log(`Skipping ${app.title} — no valid scraper URL available`, 'WARNING');
        results.push({
          ...app,
          platform: 'unknown',
          documents: []
        });
        runManager.recordApplication(app, 'unknown', false, new Error('No valid portal URL available'), 0);
        await applicationsRepository.upsertApplication({ ...app, platform: 'unknown', scrape_status: 'missing_url' }).catch(() => {});
        continue;
      }

      const platform = detectPlatform(scrapeUrl);
      runManager.log(`Detected Platform: ${platform.toUpperCase()} for ${scrapeUrl}`);

      let docsObject = { documents: [], metrics: {} };
      let success = false;
      let error = null;
      let context = null;
      let sourcePage = null;

      if (platform === 'idox') {
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

      } else if (platform === 'arcus') {
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

      } else if (platform === 'salesforce') {
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

      } else {
        runManager.log(`Skipping extraction — unsupported platform: "${platform}"`, 'WARNING');
        error = new Error(`Unsupported platform: ${platform}`);
      }

      const documents = docsObject.documents || [];
      runManager.recordApplication(app, platform, success, error, documents.length);
      await applicationsRepository.upsertApplication({
        ...app,
        platform,
        scrape_status: success ? 'scraped' : (error && error.code === 'BLOCKED' ? 'blocked' : 'failed'),
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
      if (success && documents.length > 0) {
        runManager.log(`Initiating stream downloads for ${documents.length} extracted files...`);
        for (const doc of documents) {
          // Pass the context to downloadDocument to preserve session cookies
          const downloadRecord = await downloadDocument(doc, app, app.area || 'Unknown', manifest, BROWSER_PLATFORMS.includes(platform) ? context : null);
          runManager.recordDownload(downloadRecord.status, downloadRecord.sizeBytes);
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

      // Close the page and context after downloads are complete
      if (BROWSER_PLATFORMS.includes(platform) && context) {
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
      failedDownloads: Object.values(finalSummary.errorClassification || {}).reduce((sum, count) => sum + count, 0),
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