/**
 * src/intelligence/ocr.js
 *
 * PDF text extraction layer using pdf-parse.
 * Returns raw text for downstream classification and metadata extraction.
 * Handles scanned/image PDFs gracefully with safe fallback stubs.
 */

const fs = require('fs');
const path = require('path');

/**
 * Lazily loads the pdf-parse v2 `PDFParse` class. Returns null if unavailable.
 * (v2 exports a class — `new PDFParse({ data }).getText()` — not a callable.)
 */
function getPDFParseClass() {
  try {
    return require('pdf-parse').PDFParse || null;
  } catch (e) {
    return null;
  }
}

/**
 * Extracts text from an in-memory PDF buffer (Storage-only pipeline).
 *
 * @param {Buffer} buffer - Raw PDF bytes
 * @returns {Promise<{ text: string, pageCount: number, isScanned: boolean, error: string|null }>}
 */
async function extractPdfTextFromBuffer(buffer) {
  const result = {
    text: '',
    pageCount: 0,
    isScanned: false,
    error: null
  };

  if (!buffer || buffer.length === 0) {
    result.error = 'Empty buffer';
    return result;
  }

  const PDFParse = getPDFParseClass();
  if (!PDFParse) {
    result.error = 'pdf-parse not available';
    return result;
  }

  let parser = null;
  try {
    parser = new PDFParse({ data: buffer });
    const data = await parser.getText();

    result.pageCount = data.total || (data.pages ? data.pages.length : 0) || 0;
    result.text = (data.text || '').trim();

    // Heuristic: if very little text extracted vs page count, likely scanned
    const avgCharsPerPage = result.pageCount > 0
      ? result.text.length / result.pageCount
      : 0;
    result.isScanned = result.pageCount > 0 && avgCharsPerPage < 80;

    if (result.isScanned) {
      result.error = 'Likely scanned PDF — minimal text content extracted';
    }
  } catch (err) {
    result.error = `pdf-parse error: ${err.message}`;
    // Not a fatal failure — downstream will work without text
  } finally {
    if (parser && typeof parser.destroy === 'function') {
      await parser.destroy().catch(() => {});
    }
  }

  return result;
}

/**
 * Extracts text from a local PDF file. Thin wrapper over the buffer variant,
 * kept for any legacy/disk-based caller.
 *
 * @param {string} filePath - Absolute path to the PDF file
 * @returns {Promise<{ text: string, pageCount: number, isScanned: boolean, error: string|null }>}
 */
async function extractPdfText(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { text: '', pageCount: 0, isScanned: false, error: 'File not found' };
  }
  return extractPdfTextFromBuffer(fs.readFileSync(filePath));
}

/**
 * Extracts text from a PDF given only a URL (after it has been downloaded locally).
 * Maps sourceUrl -> local path via the download manifest.
 *
 * @param {string} sourceUrl - Original doc URL
 * @param {string} manifestPath - Path to download_manifest.json
 * @returns {Promise<object>} - Same shape as extractPdfText
 */
async function extractTextFromManifest(sourceUrl, manifestPath) {
  const stub = { text: '', pageCount: 0, isScanned: false, error: null };
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    stub.error = 'Manifest not found';
    return stub;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const record = (manifest.files || []).find(f => f.sourceUrl === sourceUrl);
    if (!record || !record.localPath) {
      stub.error = 'No local file for this URL in manifest';
      return stub;
    }

    // localPath is relative to project root
    const projectRoot = path.join(__dirname, '..', '..');
    const absPath = path.join(projectRoot, record.localPath);
    return await extractPdfText(absPath);
  } catch (err) {
    stub.error = `Manifest read error: ${err.message}`;
    return stub;
  }
}

module.exports = { extractPdfText, extractPdfTextFromBuffer, extractTextFromManifest };
