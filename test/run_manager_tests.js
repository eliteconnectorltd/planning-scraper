/**
 * test/run_manager_tests.js
 *
 * Automated tests validating the operational reliability and metrics compilation
 * of the centralized RunManager.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { RunManager, ERROR_CATEGORIES } = require('../src/core/runManager');

async function runRunManagerTests() {
  console.log('=== Starting Planning Scraper RunManager Tests ===');

  const runManager = new RunManager();
  
  let failures = 0;

  try {
    // ── TEST 1: Error Categorization ─────────────────────────────────────────
    console.log('\n[test] Test 1: Error Categorization...');
    
    const errTimeout = new Error('navigation timeout exceeded value 45000ms');
    assert.strictEqual(runManager.classifyError(errTimeout), ERROR_CATEGORIES.TIMEOUT);
    
    const errBlocked = new Error('HTTP status 403 Forbidden geoblocked access');
    assert.strictEqual(runManager.classifyError(errBlocked), ERROR_CATEGORIES.BLOCKED);
    
    const errNetwork = new Error('getaddrinfo ENOTFOUND pa.newham.gov.uk');
    assert.strictEqual(runManager.classifyError(errNetwork), ERROR_CATEGORIES.NETWORK_ERROR);
    
    const errSelector = new Error('waiting for selector table#documents failed');
    assert.strictEqual(runManager.classifyError(errSelector), ERROR_CATEGORIES.SELECTOR_MISMATCH);

    const errEmpty = new Error('Zero valid documents extracted');
    assert.strictEqual(runManager.classifyError(errEmpty), ERROR_CATEGORIES.EMPTY_DOCUMENTS);

    console.log('✅ Test 1 Passed: Classified all operational errors correctly.');

    // ── TEST 2: Structured Logs ──────────────────────────────────────────────
    console.log('\n[test] Test 2: Daily Log Writer...');
    runManager.log('Test logging info');
    runManager.log('Test logging warning', 'WARNING');
    runManager.log('Test logging error', 'ERROR');
    
    assert.strictEqual(fs.existsSync(runManager.logFile), true);
    const content = fs.readFileSync(runManager.logFile, 'utf8');
    assert.ok(content.includes('Test logging info'));
    assert.ok(content.includes('[WARNING]'));
    assert.ok(content.includes('[ERROR]'));
    console.log('✅ Test 2 Passed: Structured log entries recorded on disk.');

    // ── TEST 3: Resume Support ────────────────────────────────────────────────
    console.log('\n[test] Test 3: Resume State filter...');
    const incomingApps = [
      { title: 'APP-1', area: 'Camden' },
      { title: 'APP-2', area: 'Camden' },
      { title: 'APP-3', area: 'Camden' }
    ];

    // Mock results file to simulate existing run data
    const resultsMockPath = path.join(__dirname, '..', 'output', 'results.json');
    const backupExists = fs.existsSync(resultsMockPath);
    let originalData = '';
    if (backupExists) {
      originalData = fs.readFileSync(resultsMockPath, 'utf8');
    }

    // Write a mock results containing processed app 'APP-1'
    fs.writeFileSync(resultsMockPath, JSON.stringify([
      { title: 'APP-1', area: 'Camden', platform: 'idox', documentsCount: 2, documents: [{}, {}] }
    ], null, 2));

    const queue = runManager.getResumeQueue(incomingApps);
    
    // Assert APP-1 was marked skipped_resume
    const app1 = queue.find(a => a.title === 'APP-1');
    const app2 = queue.find(a => a.title === 'APP-2');
    assert.strictEqual(app1.skipped_resume, true);
    assert.strictEqual(app2.skipped_resume, undefined);
    assert.strictEqual(runManager.metrics.applicationsSkippedResume, 1);

    // Restore backup
    if (backupExists) {
      fs.writeFileSync(resultsMockPath, originalData, 'utf8');
    } else {
      fs.unlinkSync(resultsMockPath);
    }
    console.log('✅ Test 3 Passed: Resume queue filtered and flagged existing UIDs.');

    // ── TEST 4: Cumulative Metrics & Finalize ────────────────────────────────
    console.log('\n[test] Test 4: Finalize run summary analytics...');
    runManager.recordApplication({ title: 'APP-2', area: 'Camden' }, 'idox', true, null, 3);
    runManager.recordApplication({ title: 'APP-3', area: 'Camden' }, 'idox', false, new Error('timeout waiting'), 0);
    runManager.recordDownload('downloaded', 1024);
    runManager.recordDownload('skipped_duplicate', 0);
    
    const summary = runManager.finalize();
    assert.ok(summary.summary);
    assert.strictEqual(summary.summary.documentsExtracted, 3);
    assert.strictEqual(summary.summary.downloadsCompleted, 1);
    assert.strictEqual(summary.summary.duplicatesSkipped, 1);
    assert.strictEqual(summary.analytics.avgDocsPerApplication, 3);
    assert.strictEqual(summary.analytics.duplicateRatioPercent, 50);
    assert.strictEqual(summary.councilFingerprints[0].council, 'Camden');
    assert.strictEqual(summary.councilFingerprints[0].extractionSuccessRatePercent, 50);

    console.log('✅ Test 4 Passed: Operational statistics and fingerprints compiled successfully.');

  } catch (err) {
    console.error('❌ Test Suite Assertion Failure:', err);
    failures++;
  }

  console.log('\n==============================================');
  if (failures === 0) {
    console.log('🎉 ALL RUNMANAGER TESTS PASSED SUCCESSFULLY!');
  } else {
    console.log(`❌ TEST SUITE FAILED WITH ${failures} FAILURE(S)`);
    process.exit(1);
  }
}

runRunManagerTests().catch(err => {
  console.error('Fatal crash:', err);
  process.exit(1);
});
