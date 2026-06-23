/**
 * src/intelligence/index.js
 *
 * Document Intelligence & Classification pipeline — Supabase Storage edition.
 *
 * Flow:
 *   1. Read every document that has a file in Supabase Storage
 *      (documents.storage_path is not null), joined to its application.
 *   2. Download each file's bytes from Storage (no local disk).
 *   3. Extract text via pdf-parse (in-memory buffer).
 *   4. Classify the document category with confidence scoring.
 *   5. Extract structured planning-intelligence metadata.
 *   6. Upsert the result into the Supabase `intelligence` table
 *      (idempotent on document_id + extraction_engine).
 *
 * No JSON files are read or written — the datastore is Supabase end to end.
 */

const { extractPdfTextFromBuffer } = require('./ocr');
const { classifyDocument } = require('./classifier');
const { extractMetadata } = require('./metadataExtractor');
const { downloadDocumentFile } = require('../db/storage');
const documentsRepository = require('../db/repositories/documentsRepository');
const intelligenceRepository = require('../db/repositories/intelligenceRepository');
const { isSupabaseConfigured } = require('../db/supabase');

const EXTRACTION_ENGINE = 'pdf-parse';

/**
 * Runs the intelligence pipeline over all Storage-backed documents.
 *
 * @returns {Promise<object>} summary statistics
 */
async function processDocumentIntelligence() {
  console.log('=== Initializing Document Intelligence Pipeline (Supabase Storage) ===');

  if (!isSupabaseConfigured()) {
    console.error('[intelligence] Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Nothing to do.');
    return { totalDocumentsProcessed: 0, successfullyExtractedText: 0, scannedPdfsCount: 0, failedCount: 0 };
  }

  const documents = await documentsRepository.listStoredDocuments();
  console.log(`[intelligence] Documents with Storage files: ${documents.length}`);

  let totalDocsProcessed = 0;
  let successfullyExtractedText = 0;
  let scannedPdfsCount = 0;
  let failedCount = 0;

  const categoryCounts = {};

  for (const docRow of documents) {
    totalDocsProcessed++;
    const app = docRow.applications || {};
    const docName = docRow.document_name || 'Document';
    console.log(`\n[intelligence] (${totalDocsProcessed}/${documents.length}) ${app.application_uid || '?'} → "${docName}"`);

    // 1. Pull bytes from Storage
    let buffer = null;
    try {
      buffer = await downloadDocumentFile(docRow.storage_path, docRow.storage_bucket || undefined);
    } catch (err) {
      console.warn(`  [intelligence] Storage download failed: ${err.message}`);
    }

    // 2. Extract text
    let ocrResult = { text: '', pageCount: 0, isScanned: false, error: 'Storage download failed' };
    if (buffer) {
      ocrResult = await extractPdfTextFromBuffer(buffer);
    }

    if (ocrResult.isScanned) {
      scannedPdfsCount++;
    } else if (ocrResult.error) {
      failedCount++;
    } else if (ocrResult.text) {
      successfullyExtractedText++;
    }

    // Shape a doc object the classifier / metadata extractor understand
    const docForIntel = {
      name: docName,
      type: docRow.document_type || docRow.document_category,
      date: docRow.document_date,
      url: docRow.source_url,
    };

    // 3. Classify
    const classification = classifyDocument(docForIntel, ocrResult.text);
    categoryCounts[classification.category] = (categoryCounts[classification.category] || 0) + 1;

    // 4. Structured metadata
    const metadata = extractMetadata(ocrResult.text, docForIntel, {
      council: app.council,
      address: app.address,
      proposal: app.proposal,
      received_at: app.received_at,
      applicationRef: app.application_uid,
    });

    // 5. Persist to Supabase (idempotent upsert)
    try {
      await intelligenceRepository.upsertIntelligence({
        extracted_text: ocrResult.text,
        metadata_json: metadata,
        classification: {
          category: classification.category,
          confidence: classification.confidence,
          signals: classification.signals,
        },
        confidence_score: classification.confidence,
        scanned_document: ocrResult.isScanned,
        extraction_engine: EXTRACTION_ENGINE,
      }, docRow.id);
      console.log(`  [intelligence] Stored: category=${classification.category} confidence=${classification.confidence} pages=${ocrResult.pageCount}`);
    } catch (persistErr) {
      console.warn(`  [intelligence] Supabase persistence failed: ${persistErr.message}`);
      failedCount++;
    }
  }

  const summary = {
    totalDocumentsProcessed: totalDocsProcessed,
    successfullyExtractedText,
    scannedPdfsCount,
    failedCount,
    classificationBreakdown: categoryCounts,
  };

  console.log(`\n=== Intelligence Pipeline Complete ===`);
  console.log(`Total documents processed:   ${totalDocsProcessed}`);
  console.log(`Text extracted successfully: ${successfullyExtractedText}`);
  console.log(`Scanned/image PDFs flagged:  ${scannedPdfsCount}`);
  console.log(`Failures:                    ${failedCount}`);
  console.log(`Classification breakdown:    ${JSON.stringify(categoryCounts)}`);

  return summary;
}

if (require.main === module) {
  processDocumentIntelligence().catch(err => {
    console.error('Fatal crash in document intelligence orchestrator:', err);
    process.exit(1);
  });
}

module.exports = { processDocumentIntelligence };
