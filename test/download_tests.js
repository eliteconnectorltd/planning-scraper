/**
 * test/download_tests.js
 *
 * Automated test suite validating download manager logic.
 * Uses a lightweight, self-contained local HTTP server to guarantee
 * mock environments without external network dependency or geoblocking.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const {
  validateDocumentUrl,
  extractPdfFromHtml,
  downloadDocument,
  sanitizeFilename,
  processDownloads
} = require('../src/download/downloadManager');

const PORT = 34567;
const BASE_URL = `http://localhost:${PORT}`;

// Sample PDF binary mock (a very tiny valid PDF header)
const MOCK_PDF_CONTENT = Buffer.from('%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n>>\nendobj\ntrailer\n<<\n/Root 1 0 R\n>>\n%%EOF');

let server;

// Start mock server
function startMockServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      console.log(`  [mock-server] Request: ${req.method} ${req.url}`);

      if (req.url === '/direct.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(MOCK_PDF_CONTENT);
      } else if (req.url === '/redirect') {
        res.writeHead(302, { 'Location': `${BASE_URL}/direct.pdf` });
        res.end();
      } else if (req.url === '/viewer') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body>
              <h1>Document Viewer</h1>
              <iframe src="/direct.pdf"></iframe>
            </body>
          </html>
        `);
      } else if (req.url === '/viewer-embed') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body>
              <embed src="${BASE_URL}/direct.pdf"></embed>
            </body>
          </html>
        `);
      } else if (req.url === '/404') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    });

    server.listen(PORT, () => {
      console.log(`[test] Local mock HTTP server listening on ${BASE_URL}`);
      resolve();
    });
  });
}

// Close mock server
function stopMockServer() {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        console.log('[test] Mock HTTP server stopped.');
        resolve();
      });
    } else {
      resolve();
    }
  });
}

async function runTests() {
  console.log('=== Starting Planning Scraper Phase 4 Download Tests ===');

  await startMockServer();

  let failures = 0;

  try {
    // ── TEST 1: Filename Sanitization ────────────────────────────────────────
    console.log('\n[test] Test 1: sanitizeFilename...');
    const result1 = sanitizeFilename('Planning Application / 123*?');
    assert.strictEqual(result1, 'Planning_Application_123');
    console.log('✅ Test 1 Passed: Filename sanitized correctly.');



    // ── TEST 5: PDF URL Extraction from HTML ─────────────────────────────────
    console.log('\n[test] Test 5: extractPdfFromHtml...');
    const html1 = `<html><body><iframe src="/direct.pdf"></iframe></body></html>`;
    const extracted1 = extractPdfFromHtml(html1, `${BASE_URL}/viewer`);
    assert.strictEqual(extracted1, `${BASE_URL}/direct.pdf`);

    const html2 = `<html><body><embed src="${BASE_URL}/direct.pdf"></embed></body></html>`;
    const extracted2 = extractPdfFromHtml(html2, `${BASE_URL}/viewer-embed`);
    assert.strictEqual(extracted2, `${BASE_URL}/direct.pdf`);
    console.log('✅ Test 5 Passed: Embedded PDF extracted successfully from frames/embeds.');

    // ── TEST 6: Single Document Download Integration ─────────────────────────
    console.log('\n[test] Test 6: downloadDocument...');
    const mockApp = { title: 'APP-123' };
    const mockDoc = { name: 'Main Plan Drawing', url: `${BASE_URL}/viewer` };
    const manifest = { files: [] };

    const record = await downloadDocument(mockDoc, mockApp, 'Camden', manifest);
    assert.strictEqual(record.status, 'downloaded');
    assert.strictEqual(record.normalizedName, 'Main_Plan_Drawing.pdf');
    assert.strictEqual(record.sizeBytes > 0, true);
    assert.ok(record.sha256);
    assert.strictEqual(fs.existsSync(path.join(__dirname, '..', record.localPath)), true);
    console.log('✅ Test 6 Passed: Full download integration (HTML extraction -> save file -> verify hash) succeeded.');

    // ── TEST 7: Duplicate Detection ──────────────────────────────────────────
    console.log('\n[test] Test 7: Duplicate Detection...');
    manifest.files.push(record);

    // Path based duplicate check (same file on disk)
    const duplicateRecordPath = await downloadDocument(mockDoc, mockApp, 'Camden', manifest);
    assert.strictEqual(duplicateRecordPath.status, 'skipped_duplicate');
    assert.strictEqual(duplicateRecordPath.sha256, record.sha256);
    console.log('✅ Test 7 Passed: Duplicate path detected and skipped.');

  } catch (err) {
    console.error('❌ Test Suite Assertion Failure:', err);
    failures++;
  } finally {
    await stopMockServer();
  }

  // Cleanup downloaded files in tests
  const testDownloadsDir = path.join(__dirname, '..', 'output', 'downloads', 'Camden', 'APP-123');
  try {
    if (fs.existsSync(testDownloadsDir)) {
      const files = fs.readdirSync(testDownloadsDir);
      for (const file of files) {
        fs.unlinkSync(path.join(testDownloadsDir, file));
      }
      fs.rmdirSync(testDownloadsDir);
      fs.rmdirSync(path.join(__dirname, '..', 'output', 'downloads', 'Camden'));
    }
  } catch (e) {
    // Ignore cleanup errors
  }

  console.log('\n==============================================');
  if (failures === 0) {
    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
  } else {
    console.log(`❌ TEST SUITE FAILED WITH ${failures} FAILURE(S)`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
