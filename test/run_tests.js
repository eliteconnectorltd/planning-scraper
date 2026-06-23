/**
 * test/run_tests.js
 *
 * Automated test suite to validate the production-grade Idox document extraction.
 * Uses the local mock HTML file to simulate the exact Idox portal DOM structure.
 * Resolves network limitations/geoblocking to ensure robust logic verification.
 */

const path = require('path');
const { chromium } = require('playwright');
const { 
  openDocumentsTab, 
  extractDocumentRows, 
  normalizeDocument, 
  scrapeIdoxDocuments 
} = require('../src/adapters/idox');

async function runTests() {
  console.log('=== Starting Planning Scraper MVP Test Suite ===');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Load the local mock HTML page using file protocol
  const mockFilePath = path.resolve(__dirname, 'mock_idox.html');
  const mockFileUrl = `file://${mockFilePath}`;
  
  console.log(`[test] Loading mock portal: ${mockFileUrl}`);
  
  let failures = 0;

  try {
    // ── TEST 1: Open Documents Tab ───────────────────────────────────────────
    console.log('\n[test] Running Test 1: openDocumentsTab...');
    const tabResult = await openDocumentsTab(page, mockFileUrl);
    if (tabResult === true) {
      console.log('✅ Test 1 Passed: openDocumentsTab successfully navigated and confirmed tab active.');
    } else {
      console.log('❌ Test 1 Failed: openDocumentsTab returned false.');
      failures++;
    }

    // ── TEST 2: Extract Document Rows ────────────────────────────────────────
    console.log('\n[test] Running Test 2: extractDocumentRows...');
    const rawData = await extractDocumentRows(page);
    const rawRows = rawData.rows;
    
    if (rawData && rawRows && rawRows.length === 4) {
      console.log('✅ Test 2 Passed: Successfully extracted exactly 4 rows.');
      console.log(`[test] Raw rows returned:`, JSON.stringify(rawRows, null, 2));
    } else {
      console.log(`❌ Test 2 Failed: Expected 4 rows, got ${rawRows ? rawRows.length : undefined}`);
      failures++;
    }

    // ── TEST 3: Normalize & Filter Documents ─────────────────────────────────
    console.log('\n[test] Running Test 3: normalizeDocument...');
    const baseUrl = 'https://pa.newham.gov.uk/online-applications/applicationDetails.do?activeTab=documents&keyVal=SWXDIXJYJIV00';
    
    // Test a normal row with relative paths
    const sampleRow = {
      rawName: 'Design and Access Statement',
      rawType: 'Supporting Documents',
      rawDate: '13 Jun 2025',
      rawUrl: 'showDocument.do?documentId=998877'
    };
    
    const normalized = normalizeDocument(sampleRow, baseUrl);
    
    if (
      normalized &&
      normalized.name === 'Design and Access Statement' &&
      normalized.type === 'Supporting Documents' &&
      normalized.date === '13 Jun 2025' &&
      normalized.url === 'https://pa.newham.gov.uk/online-applications/showDocument.do?documentId=998877'
    ) {
      console.log('✅ Test 3 Passed: Successfully normalized row and resolved relative URL.');
      console.log(`[test] Normalized record:`, normalized);
    } else {
      console.log('❌ Test 3 Failed: Normalized output mismatch.', normalized);
      failures++;
    }

    // Test filtering of navigation links
    console.log('\n[test] Running Test 4: Filtering out navigation links...');
    const navRow = {
      rawName: 'Simple Search',
      rawType: 'System link',
      rawDate: '',
      rawUrl: '/online-applications/search.do?action=simple'
    };
    const navNormalized = normalizeDocument(navRow, baseUrl);
    if (navNormalized === null) {
      console.log('✅ Test 4 Passed: Correctly filtered out system search URL.');
    } else {
      console.log('❌ Test 4 Failed: Failed to filter system URL.', navNormalized);
      failures++;
    }

    // ── TEST 5: scrapeIdoxDocuments Orchestrator ──────────────────────────────
    console.log('\n[test] Running Test 5: Full scrapeIdoxDocuments integration...');
    const result = await scrapeIdoxDocuments(page, mockFileUrl);
    const documents = result.documents;
    const metrics = result.metrics;
    
    if (documents && documents.length === 4 && metrics && metrics.success) {
      console.log('✅ Test 5 Passed: scrapeIdoxDocuments successfully ran full pipeline.');
      console.log(`[test] Metrics returned:`, metrics);
      console.log('[test] Extracted Documents (Exact structure { name, type, date, url, confidence }):');
      console.log(JSON.stringify(documents, null, 2));

      // Validate exact keys in the returned array
      const keysValid = documents.every(doc => 
        doc.hasOwnProperty('name') && 
        doc.hasOwnProperty('type') && 
        doc.hasOwnProperty('date') && 
        doc.hasOwnProperty('url') &&
        doc.hasOwnProperty('confidence') &&
        Object.keys(doc).length === 5
      );
      if (keysValid) {
        console.log('✅ Test 6 Passed: Output structure exactly matches `{ name, type, date, url }`.');
      } else {
        console.log('❌ Test 6 Failed: Output keys mismatch. Keys found:', Object.keys(documents[0]));
        failures++;
      }
    } else {
      console.log(`❌ Test 5 Failed: Expected 4 normalized documents, got ${documents ? documents.length : 0}`);
      failures++;
    }

  } catch (err) {
    console.error('❌ Test Execution Error:', err);
    failures++;
  } finally {
    await browser.close();
  }

  console.log('\n==============================================');
  if (failures === 0) {
    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! (6/6)');
  } else {
    console.log(`❌ TEST SUITE FAILED WITH ${failures} FAILURE(S)`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal testing error:', err);
  process.exit(1);
});
