/**
 * test/live_validation.js
 *
 * Validation runner for testing the production-grade Idox document scraper
 * against real live UK council portals. Aligned to Phase 5 RunManager logs and classifications.
 */

const fs = require('fs');
const path = require('path');
const { createBrowser } = require('../src/browser');
const { scrapeIdoxDocuments } = require('../src/adapters/idox');
const { RunManager } = require('../src/core/runManager');

// Configurable list of real live Idox portal targets for validation
const PORTAL_TARGETS = [
  {
    council: 'Newham Council',
    url: 'https://pa.newham.gov.uk/online-applications/applicationDetails.do?activeTab=documents&keyVal=SWXDIXJYJIV00',
    expectedDocs: 14
  },
  {
    council: 'Uttlesford District Council (TPO)',
    url: 'https://publicaccess.uttlesford.gov.uk/online-applications/applicationDetails.do?activeTab=documents&keyVal=TFG59YQNM7W00',
    expectedDocs: 8
  },
  {
    council: 'Uttlesford District Council (PIP)',
    url: 'https://publicaccess.uttlesford.gov.uk/online-applications/applicationDetails.do?activeTab=documents&keyVal=TFJKYIQN01O00',
    expectedDocs: 2
  },
  {
    council: 'Camden Council',
    url: 'https://planningrecords.camden.gov.uk/online-applications/applicationDetails.do?activeTab=documents&keyVal=SVV1TNGIGD000',
    expectedDocs: null
  },
  {
    council: 'Westminster City Council',
    url: 'https://idoxpa.westminster.gov.uk/online-applications/applicationDetails.do?activeTab=documents&keyVal=SU90D0KSMX000',
    expectedDocs: null
  }
];

const OUTPUT_FILE = path.join(__dirname, '..', 'output', 'live_validation.json');

async function runLiveValidation() {
  const runManager = new RunManager();
  runManager.log('================================================================================');
  runManager.log('🚀 INITIATING REAL IDOX PORTAL VALIDATION RUNNER');
  runManager.log(`Targeting ${PORTAL_TARGETS.length} live portals...`);
  runManager.log('================================================================================');

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Force headless mode for validation runs
  process.env.HEADLESS = 'true';
  const browser = await createBrowser();
  const context = await browser.newContext();

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      totalPortals: PORTAL_TARGETS.length,
      successfulRuns: 0,
      failedRuns: 0,
      blockedRuns: 0,
      timeoutRuns: 0,
      totalDocumentsScraped: 0
    },
    results: []
  };

  for (const target of PORTAL_TARGETS) {
    runManager.log(`----------------------------------------------------------------------`);
    runManager.log(`Council:   ${target.council}`);
    runManager.log(`Target URL: ${target.url}`);
    
    const page = await context.newPage();
    const startTime = Date.now();
    
    let success = false;
    let documents = [];
    let metrics = null;
    let errorCategory = null;
    let errorMessage = null;

    try {
      // Execute the production adapter
      const result = await scrapeIdoxDocuments(page, target.url);
      documents = result.documents;
      metrics = result.metrics;
      success = metrics.success && documents.length > 0;
      
      if (!success) {
        throw new Error(documents.length === 0 ? 'Zero valid documents extracted' : 'Extraction reported unsuccessful');
      }

      runManager.log(`✅ SUCCESS: Scraped ${documents.length} documents.`);
    } catch (err) {
      errorMessage = err.message;
      success = false;
      errorCategory = runManager.classifyError(err);
      
      runManager.log(`❌ FAILURE: ${errorMessage}`, 'ERROR');
      runManager.log(`Category: ${errorCategory}`);
    } finally {
      await page.close();
    }

    const duration = Date.now() - startTime;

    // Compile record entry
    const resultEntry = {
      council: target.council,
      url: target.url,
      success,
      durationMs: duration,
      expectedDocs: target.expectedDocs,
      extractedCount: documents.length,
      metrics: metrics || {
        totalRows: 0,
        validDocs: 0,
        filteredRows: 0,
        duplicateDocs: 0,
        runtimeMs: duration,
        success: false
      },
      error: errorMessage ? {
        message: errorMessage,
        category: errorCategory
      } : null
    };

    // Update global metrics
    if (success) {
      report.summary.successfulRuns++;
      report.summary.totalDocumentsScraped += documents.length;
    } else {
      report.summary.failedRuns++;
      if (errorCategory === 'BLOCKED') report.summary.blockedRuns++;
      if (errorCategory === 'TIMEOUT') report.summary.timeoutRuns++;
    }

    report.results.push(resultEntry);

    // Save incremental updates to JSON file
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2), 'utf8');

    // Small delay between targets
    await new Promise(r => setTimeout(r, 2000));
  }

  await browser.close();

  runManager.log('================================================================================');
  runManager.log('📊 VALIDATION SUMMARY REPORT:');
  runManager.log(`  Total Targets Tested:   ${report.summary.totalPortals}`);
  runManager.log(`  Successful Extractions: ${report.summary.successfulRuns}`);
  runManager.log(`  Failed Extractions:     ${report.summary.failedRuns} (Blocked: ${report.summary.blockedRuns}, Timeout: ${report.summary.timeoutRuns})`);
  runManager.log(`  Total Docs Scraped:     ${report.summary.totalDocumentsScraped}`);
  runManager.log(`  Report Saved To:        ${OUTPUT_FILE}`);
  runManager.log('================================================================================');

  runManager.finalize();
}

// Run the script directly if triggered
if (require.main === module) {
  runLiveValidation().catch(err => {
    console.error('Fatal crash in validation runner:', err);
    process.exit(1);
  });
}

module.exports = {
  runLiveValidation,
  PORTAL_TARGETS
};
