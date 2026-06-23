/**
 * test/intelligence_tests.js
 *
 * Fully offline automated test suite validating the planning document intelligence subsystem:
 *   1. Category Classification & Confidence Scoring
 *   2. Regex-based Metadata Extraction (Ref, Proposal, Decision, Date, Applicant, Address)
 *   3. Pipeline Orchestrator Integration using local mock records
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Load target intelligence modules
const { classifyDocument } = require('../src/intelligence/classifier');
const { extractMetadata } = require('../src/intelligence/metadataExtractor');
const { processDocumentIntelligence } = require('../src/intelligence/index');
const { CATEGORIES } = require('../src/intelligence/heuristics');

async function runIntelligenceTests() {
  console.log('=== Starting Planning Scraper Document Intelligence Test Suite ===');
  
  let failures = 0;

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1: DIRECT TYPE FIELD LOOKUP CLASSIFICATION
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[test] Test 1: Direct Type-Field Lookup...');
    const docTypeMatch = classifyDocument({
      name: 'Random Document Title.pdf',
      type: 'Proposed elevations'
    });
    
    assert.strictEqual(docTypeMatch.category, CATEGORIES.ELEVATION_DRAWING);
    assert.strictEqual(docTypeMatch.confidence, 0.95);
    assert.ok(docTypeMatch.signals.includes('type_field_match:"Proposed elevations"'));
    console.log('✅ Test 1 Passed: Direct type-field lookup matches canonical categories with high confidence.');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2: FILENAME & KEYWORD HYBRID CLASSIFICATION
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[test] Test 2: Filename & Keyword Scoring...');
    const docFilenameMatch = classifyDocument({
      name: 'das_rev_a_2025.pdf',
      type: 'Unmapped Category'
    });
    
    assert.strictEqual(docFilenameMatch.category, CATEGORIES.DESIGN_ACCESS_STATEMENT);
    assert.ok(docFilenameMatch.confidence > 0.4);
    assert.ok(docFilenameMatch.signals.includes('filename_pattern_match'));
    console.log('✅ Test 2 Passed: Correctly resolved design & access statement via filename patterns.');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3: LOW CONFIDENCE FALLBACKS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[test] Test 3: Low-Confidence Fallbacks...');
    const docUnknown = classifyDocument({
      name: 'xyz.pdf',
      type: 'unknown_type'
    });
    
    assert.strictEqual(docUnknown.category, CATEGORIES.SUPPORTING_DOCUMENT);
    assert.strictEqual(docUnknown.confidence, 0.10);
    assert.ok(docUnknown.signals.includes('fallback'));
    console.log('✅ Test 3 Passed: Correctly fell back to Supporting Document for non-matching inputs.');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4: METADATA EXTRACTION FROM TEXT
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[test] Test 4: Structured Metadata Extraction...');
    const samplePdfText = `
      PLANNING CERTIFICATE
      PLANNING APPLICATION REFERENCE: 25/0999/FULL
      DATED THIS 18th DAY OF June 2026
      
      APPLICANT: Mr John Doe (on behalf of Acme Developments Ltd)
      SITE ADDRESS: 12 High Street, West Ham, London, E15 2BB
      
      PROPOSAL: Demolition of existing structures and erection of a 3-storey building.
      
      The Council having considered this planning application hereby confirms that
      planning permission is granted for the proposed development subject to standard conditions.
    `;

    const docContext = {
      name: 'decision_letter.pdf',
      type: 'decision',
      date: '2026-06-20'
    };

    const appContext = {
      title: '25/0999/FULL',
      area: 'Newham',
      address: '12 High Street, West Ham',
      description: 'Erection of a building.'
    };

    const extracted = extractMetadata(samplePdfText, docContext, appContext);
    
    // Check extracted fields
    assert.strictEqual(extracted.applicationRef, '25/0999/FULL');
    assert.strictEqual(extracted.decision, 'GRANTED');
    assert.strictEqual(extracted.decisionDate, '18th DAY OF June 2026');
    assert.strictEqual(extracted.applicant, 'Mr John Doe (on behalf of Acme Developments Ltd)');
    assert.strictEqual(extracted.address, '12 High Street, West Ham, London, E15 2BB');
    assert.strictEqual(extracted.proposal, 'Demolition of existing structures and erection of a 3-storey building.');
    assert.strictEqual(extracted.council, 'Newham');

    console.log('✅ Test 4 Passed: Extracted planning intelligence fields successfully from text.');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5: ORCHESTRATOR INTEGRATION WITH LOCAL MOCK DATA
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[test] Test 5: Full pipeline orchestration using mock data...');
    
    // Set up mock file inputs
    const tempDir = path.join(__dirname, 'mock_intelligence_run');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }

    const mockResultsPath = path.join(tempDir, 'results.json');
    const mockManifestPath = path.join(tempDir, 'download_manifest.json');
    const mockIntelDir = path.join(tempDir, 'intelligence');
    const mockIntelManifestPath = path.join(tempDir, 'intelligence_manifest.json');

    // Clean any prior runs
    if (fs.existsSync(mockIntelManifestPath)) fs.unlinkSync(mockIntelManifestPath);
    if (fs.existsSync(mockIntelDir)) {
      fs.rmSync(mockIntelDir, { recursive: true, force: true });
    }

    // 1. Write mock results.json
    const mockResults = [
      {
        title: 'APP-TEST-99',
        area: 'Testshire',
        address: '99 Mock Lane',
        description: 'Test proposal description',
        documents: [
          {
            name: 'Decision_Notice_99.pdf',
            type: 'Decision Notice',
            date: '2026-05-01',
            url: 'https://portal.testshire.gov.uk/docs/dn99'
          },
          {
            name: 'Proposed_Ground_Floor_Plan.pdf',
            type: 'Floor Plan',
            date: '2026-05-01',
            url: 'https://portal.testshire.gov.uk/docs/fp99'
          }
        ]
      }
    ];
    fs.writeFileSync(mockResultsPath, JSON.stringify(mockResults, null, 2), 'utf8');

    // 2. Write mock download_manifest.json (simulating files not downloaded yet or missing)
    const mockManifest = {
      generatedAt: new Date().toISOString(),
      files: [
        {
          council: 'Testshire',
          application: 'APP-TEST-99',
          originalName: 'Decision_Notice_99.pdf',
          sourceUrl: 'https://portal.testshire.gov.uk/docs/dn99',
          status: 'downloaded',
          localPath: 'test/mock_intelligence_run/downloads/dn99.pdf'
        }
      ]
    };
    fs.writeFileSync(mockManifestPath, JSON.stringify(mockManifest, null, 2), 'utf8');

    // Run orchestrator with these paths
    const intelManifest = await processDocumentIntelligence({
      resultsPath: mockResultsPath,
      downloadManifestPath: mockManifestPath,
      intelligenceDir: mockIntelDir,
      intelManifestPath: mockIntelManifestPath
    });

    // Assert manifest file is produced
    assert.strictEqual(fs.existsSync(mockIntelManifestPath), true);
    
    // Assert metrics inside manifest
    assert.strictEqual(intelManifest.summary.totalApplicationsProcessed, 1);
    assert.strictEqual(intelManifest.summary.totalDocumentsProcessed, 2);
    assert.strictEqual(intelManifest.classificationBreakdown[CATEGORIES.DECISION_NOTICE], 1);
    assert.strictEqual(intelManifest.classificationBreakdown[CATEGORIES.FLOOR_PLAN], 1);

    // Verify individual files are produced mirroring the folder structure
    const singleDNPath = path.join(mockIntelDir, 'Testshire', 'APP-TEST-99', 'Decision_Notice_99.json');
    assert.strictEqual(fs.existsSync(singleDNPath), true);

    const dnIntel = JSON.parse(fs.readFileSync(singleDNPath, 'utf8'));
    assert.strictEqual(dnIntel.classification.category, CATEGORIES.DECISION_NOTICE);
    assert.strictEqual(dnIntel.classification.confidence, 0.95);
    
    console.log('✅ Test 5 Passed: Full orchestrator pipeline ran successfully with mock datasets.');

    // ── CLEAN UP MOCK TEST FILES ─────────────────────────────────────────────
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('[test] Cleared all temporary testing mock files.');

  } catch (err) {
    console.error('❌ Test Assertion Failure:', err);
    failures++;
  }

  console.log('\n==============================================');
  if (failures === 0) {
    console.log('🎉 ALL DOCUMENT INTELLIGENCE TESTS PASSED SUCCESSFULLY! (5/5)');
  } else {
    console.log(`❌ TEST SUITE FAILED WITH ${failures} FAILURE(S)`);
    process.exit(1);
  }
}

runIntelligenceTests().catch(err => {
  console.error('Fatal testing crash:', err);
  process.exit(1);
});
