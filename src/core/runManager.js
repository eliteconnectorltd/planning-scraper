/**
 * src/core/runManager.js
 *
 * Centralized operational reliability, tracking, observation, and resume manager.
 * Features structured daily logging, precise error categorization, resume checks,
 * council fingerprinting, and automated metrics analytics.
 */

const fs = require('fs');
const path = require('path');

// ── CONFIG & CONSTANTS ────────────────────────────────────────────────────────
const LOGS_ROOT = path.join(__dirname, '..', '..', 'logs');
const SUMMARY_PATH = path.join(__dirname, '..', '..', 'output', 'run_summary.json');
const RESULTS_PATH = path.join(__dirname, '..', '..', 'output', 'results.json');

// Error categories
const ERROR_CATEGORIES = {
  TIMEOUT: 'TIMEOUT',
  BLOCKED: 'BLOCKED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SELECTOR_MISMATCH: 'SELECTOR_MISMATCH',
  EMPTY_DOCUMENTS: 'EMPTY_DOCUMENTS',
  INVALID_PDF: 'INVALID_PDF',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  VIEWER_EXTRACTION_FAILED: 'VIEWER_EXTRACTION_FAILED',
  UNKNOWN: 'UNKNOWN'
};

class RunManager {
  constructor() {
    this.startTime = Date.now();
    this.logsDir = '';
    this.logFile = '';
    
    // Core Metrics
    this.metrics = {
      applicationsProcessed: 0,
      applicationsSuccessful: 0,
      applicationsFailed: 0,
      applicationsSkippedResume: 0,
      councilsProcessed: new Set(),
      documentsExtracted: 0,
      downloadsCompleted: 0,
      duplicatesSkipped: 0,
      errors: {} // Count of each classified error
    };

    // Fingerprints of councils
    this.councils = {}; // councilName -> { platform, successCount, failCount, docsCount }

    this.initializeLogging();
  }

  /**
   * Generates daily logging directory and handles streams.
   */
  initializeLogging() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    this.logsDir = path.join(LOGS_ROOT, today);
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
    this.logFile = path.join(this.logsDir, 'run.log');
    
    this.log('=== Scraper Execution Initialized ===');
  }

  /**
   * Safe file logger.
   */
  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] [${level}] ${message}\n`;
    
    // Print to console
    if (level === 'ERROR') {
      console.error(formatted.trim());
    } else {
      console.log(formatted.trim());
    }

    // Append to file
    try {
      fs.appendFileSync(this.logFile, formatted, 'utf8');
    } catch (err) {
      console.error(`Failed to write to log file: ${err.message}`);
    }
  }

  /**
   * Robust error classifier.
   */
  classifyError(err, context = '') {
    if (!err) return ERROR_CATEGORIES.UNKNOWN;
    const msg = (typeof err === 'string' ? err : err.message || '').toUpperCase();

    if (msg.includes('TIMEOUT') || msg.includes('TIMED OUT') || msg.includes('WAITFOR')) {
      return ERROR_CATEGORIES.TIMEOUT;
    }
    if (
      msg.includes('BLOCKED') ||
      msg.includes('DENIED') ||
      msg.includes('FORBIDDEN') ||
      msg.includes('403') ||
      msg.includes('GEOBLOCK')
    ) {
      return ERROR_CATEGORIES.BLOCKED;
    }
    if (
      msg.includes('NET::') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('CONNECTION') ||
      msg.includes('DNS')
    ) {
      return ERROR_CATEGORIES.NETWORK_ERROR;
    }
    if (msg.includes('SELECTOR') || msg.includes('TABLE') || msg.includes('ELEMENT')) {
      return ERROR_CATEGORIES.SELECTOR_MISMATCH;
    }
    if (msg.includes('ZERO VALID') || msg.includes('EMPTY DOCUMENTS') || msg.includes('NO DOCUMENTS')) {
      return ERROR_CATEGORIES.EMPTY_DOCUMENTS;
    }
    if (msg.includes('INVALID PDF') || msg.includes('BAD PDF') || msg.includes('HEADER')) {
      return ERROR_CATEGORIES.INVALID_PDF;
    }
    if (msg.includes('DOWNLOAD') || msg.includes('STREAM PIPE') || msg.includes('WRITE')) {
      return ERROR_CATEGORIES.DOWNLOAD_FAILED;
    }
    if (msg.includes('VIEWER') || msg.includes('EXTRACTION FROM HTML') || msg.includes('HTML VIEWER')) {
      return ERROR_CATEGORIES.VIEWER_EXTRACTION_FAILED;
    }

    return ERROR_CATEGORIES.UNKNOWN;
  }

  /**
   * Tracks an processed application results.
   */
  recordApplication(app, platform, success, error = null, extractedCount = 0) {
    this.metrics.applicationsProcessed++;
    const council = app.area || 'Unknown';
    this.metrics.councilsProcessed.add(council);

    if (!this.councils[council]) {
      this.councils[council] = {
        council,
        platform: platform || 'idox',
        successCount: 0,
        failCount: 0,
        docsCount: 0
      };
    }

    if (success) {
      this.metrics.applicationsSuccessful++;
      this.councils[council].successCount++;
      this.councils[council].docsCount += extractedCount;
      this.metrics.documentsExtracted += extractedCount;
      this.log(`Successfully processed: ${app.title} (Council: ${council}, Docs: ${extractedCount})`);
    } else {
      this.metrics.applicationsFailed++;
      this.councils[council].failCount++;
      const category = this.classifyError(error);
      this.metrics.errors[category] = (this.metrics.errors[category] || 0) + 1;
      this.log(`Failed processing: ${app.title} (Council: ${council}, Error: ${error ? error.message : 'Unknown'}, Class: ${category})`, 'WARNING');
    }
  }

  /**
   * Tracks download events.
   */
  recordDownload(status, sizeBytes = 0) {
    if (status === 'downloaded') {
      this.metrics.downloadsCompleted++;
    } else if (status === 'skipped_duplicate') {
      this.metrics.duplicatesSkipped++;
    }
  }

  /**
   * Reads previous output/results.json to determine which applications were processed successfully
   * with extracted documents, permitting resume capabilities.
   */
  getResumeQueue(incomingApplications) {
    if (String(process.env.DISABLE_RESUME || '').toLowerCase() === 'true') {
      this.log('Resume Support: Disabled for this run.');
      return incomingApplications;
    }

    if (!fs.existsSync(RESULTS_PATH)) {
      return incomingApplications;
    }

    try {
      const existing = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
      const finishedMap = new Map();

      for (const app of existing) {
        // App is successful if it was platform-processed, docs are populated or count was checked
        const hasDocs = app.documentsCount > 0 || (app.documents && app.documents.length > 0) || app.documentsCount === 0;
        if (app.platform && app.platform !== 'unknown' && hasDocs) {
          finishedMap.set(app.title, app);
        }
      }

      const queue = [];
      for (const app of incomingApplications) {
        if (finishedMap.has(app.title)) {
          this.metrics.applicationsSkippedResume++;
          // Carry over previous results directly
          queue.push({ ...finishedMap.get(app.title), skipped_resume: true });
          this.log(`Resume Support: Skipping already processed application ${app.title}`);
        } else {
          queue.push(app);
        }
      }

      return queue;
    } catch (err) {
      this.log(`Error parsing resume state: ${err.message}. Running complete queue.`, 'WARNING');
      return incomingApplications;
    }
  }

  /**
   * Generates summary file at run completion.
   */
  finalize() {
    const duration = Date.now() - this.startTime;
    
    // Compile council finger prints
    const councilSummary = Object.values(this.councils).map(c => {
      const total = c.successCount + c.failCount;
      const rate = total > 0 ? (c.successCount / total) * 100 : 0;
      return {
        council: c.council,
        platform: c.platform,
        successCount: c.successCount,
        failCount: c.failCount,
        extractionSuccessRatePercent: Number(rate.toFixed(2)),
        documentsExtracted: c.docsCount
      };
    });

    // Top failing councils
    const topFailing = [...councilSummary]
      .filter(c => c.failCount > 0)
      .sort((a, b) => b.failCount - a.failCount)
      .map(c => ({ council: c.council, failures: c.failCount }));

    const analytics = {
      avgDocsPerApplication: this.metrics.applicationsSuccessful > 0 
        ? Number((this.metrics.documentsExtracted / this.metrics.applicationsSuccessful).toFixed(2)) 
        : 0,
      duplicateRatioPercent: (this.metrics.downloadsCompleted + this.metrics.duplicatesSkipped) > 0
        ? Number((this.metrics.duplicatesSkipped / (this.metrics.downloadsCompleted + this.metrics.duplicatesSkipped) * 100).toFixed(2))
        : 0,
      topFailingCouncils: topFailing
    };

    const finalSummary = {
      generatedAt: new Date().toISOString(),
      runtimeMs: duration,
      runtimeFormatted: `${(duration / 1000).toFixed(2)}s`,
      summary: {
        totalProcessed: this.metrics.applicationsProcessed,
        successful: this.metrics.applicationsSuccessful,
        failed: this.metrics.applicationsFailed,
        skippedResume: this.metrics.applicationsSkippedResume,
        councilsCount: this.metrics.councilsProcessed.size,
        documentsExtracted: this.metrics.documentsExtracted,
        downloadsCompleted: this.metrics.downloadsCompleted,
        duplicatesSkipped: this.metrics.duplicatesSkipped
      },
      errorClassification: this.metrics.errors,
      councilFingerprints: councilSummary,
      analytics
    };

    try {
      fs.writeFileSync(SUMMARY_PATH, JSON.stringify(finalSummary, null, 2), 'utf8');
      this.log(`=== Scraper Execution Finished in ${finalSummary.runtimeFormatted} ===`);
      this.log(`Run summary saved to ${SUMMARY_PATH}`);
    } catch (err) {
      this.log(`Failed writing summary JSON: ${err.message}`, 'ERROR');
    }

    return finalSummary;
  }
}

module.exports = {
  RunManager,
  ERROR_CATEGORIES
};
