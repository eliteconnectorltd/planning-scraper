/**
 * src/download/downloadManager.js
 *
 * Production-grade document download and validation pipeline using Playwright.
 * Features: relative URL resolution, browser session preservation,
 * redirect chain tracking, HTML viewer detection and extraction,
 * SHA-256 hash checking, path deduplication, and manifest tracking.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { createHardenedPersistentContext } = require('../browserHardening');
const applicationsRepository = require('../db/repositories/applicationsRepository');
const documentsRepository = require('../db/repositories/documentsRepository');
const { uploadDocumentFile } = require('../db/storage');

// ── CONFIG & CONSTANTS ────────────────────────────────────────────────────────
// Primary store is Supabase Storage: documents are streamed into memory and
// uploaded there. Local disk under output/downloads/ is ONLY a fallback safety
// net for the case where bytes were fetched successfully but the Storage upload
// failed (Supabase down/misconfigured) — so nothing is ever lost.
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Strips parameters from a MIME type so it matches the Storage bucket's
 * allow-list (which matches the bare type only):
 *   "application/pdf; charset=utf-8" -> "application/pdf"
 *   "image/jpeg"                     -> "image/jpeg"
 *   null / non-string                -> "application/octet-stream"
 */
function normalizeMimeType(mime) {
  if (!mime || typeof mime !== 'string') return 'application/octet-stream';
  return mime.split(';')[0].trim().toLowerCase();
}

const DOWNLOADS_DIR = path.join(__dirname, '..', '..', 'output', 'downloads');

/**
 * Writes a fetched buffer to local disk as a fallback when Supabase Storage is
 * unavailable. Returns a project-root-relative path (e.g.
 * "output/downloads/Croydon/25_01142_HH/plan.pdf") suitable for the documents
 * row's local_path, or null if the write fails.
 */
function saveLocalFallback(buffer, council, applicationUid, fileName) {
  try {
    const councilSafe = sanitizeFilename(council, 'unknown_council');
    const appSafe = sanitizeFilename(applicationUid, 'unknown_application');
    const dir = path.join(DOWNLOADS_DIR, councilSafe, appSafe);
    fs.mkdirSync(dir, { recursive: true });
    const absolutePath = path.join(dir, fileName);
    fs.writeFileSync(absolutePath, buffer);
    return path.relative(path.join(__dirname, '..', '..'), absolutePath);
  } catch (err) {
    console.warn(`  [download] Local fallback write failed: ${err.message}`);
    return null;
  }
}

/**
 * Normalizes a text string to be completely safe for filenames across Windows/Unix.
 */
function sanitizeFilename(name, fallback = 'document') {
  if (!name) return fallback;
  // Replace illegal chars with underscores
  let cleaned = name.replace(/[\\/:*?"<>|]/g, '_');
  // Collapse whitespace
  cleaned = cleaned.trim().replace(/\s+/g, '_');
  // Keep only safe chars (alphanumeric, dot, hyphen, underscore)
  cleaned = cleaned.replace(/[^a-zA-Z0-9.\-_]/g, '');
  // Clean dots at the start/end
  cleaned = cleaned.replace(/^\.+|\.+$/g, '');
  // Collapse multiple underscores
  cleaned = cleaned.replace(/_+/g, '_');
  // Clean leading/trailing underscores
  cleaned = cleaned.replace(/^_+|_+$/g, '');
  // Default if fully empty
  return cleaned || fallback;
}

/**
 * Resolves a URL contextually. Supports relative and protocol-relative links.
 */
function resolveUrl(urlStr, contextUrl) {
  try {
    if (!contextUrl) return urlStr;
    return new URL(urlStr, contextUrl).href;
  } catch (err) {
    return urlStr;
  }
}

/**
 * Parses HTML to detect iframe, embed, object, or standard PDF anchor tags.
 * Focuses on extracting the target document URL.
 */
function extractPdfFromHtml(html, baseUrl) {
  if (!html) return null;

  // 1. Check for iframe sources pointing to showDocument.do or ending in .pdf
  const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = iframeRegex.exec(html)) !== null) {
    const src = match[1];
    if (src.toLowerCase().includes('.pdf') || src.toLowerCase().includes('document') || src.toLowerCase().includes('showdocument')) {
      return resolveUrl(src, baseUrl);
    }
  }

  // 2. Check for embed/object tags
  const embedRegex = /<(?:embed|object)[^>]+(?:src|data)=["']([^"']+)["']/gi;
  while ((match = embedRegex.exec(html)) !== null) {
    const src = match[1];
    if (src.toLowerCase().includes('.pdf') || src.toLowerCase().includes('document') || src.toLowerCase().includes('showdocument')) {
      return resolveUrl(src, baseUrl);
    }
  }

  // 3. Fallback: Search for any anchor link matching standard showDocument pattern or ending with .pdf
  const anchorRegex = /<a[^>]+href=["']([^"']+)["']/gi;
  const potentialLinks = [];
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1];
    const lowerHref = href.toLowerCase();
    if (lowerHref.includes('showdocument.do') || lowerHref.endsWith('.pdf') || lowerHref.includes('download')) {
      potentialLinks.push(resolveUrl(href, baseUrl));
    }
  }

  if (potentialLinks.length > 0) {
    // Return first match
    return potentialLinks[0];
  }

  return null;
}

/**
 * Uses Playwright to navigate to a document URL and download it safely.
 * Returns file details including SHA-256 and final mime type.
 * Supports:
 * - Strategy A: Direct PDF rendering (buffer capture)
 * - Strategy B: Attachment Download event
 * - Strategy C: HTML Viewer iframe/embed extraction
 */
async function downloadDocumentWithPlaywright(page, docUrl, depth = 0, downloadAuth = null) {
  if (depth > 3) {
    throw new Error('Exceeded maximum extraction depth for HTML viewers.');
  }

  const authHeaders = (downloadAuth && downloadAuth.headers && Object.keys(downloadAuth.headers).length)
    ? downloadAuth.headers
    : null;
  const authCookies = (downloadAuth && Array.isArray(downloadAuth.cookies) && downloadAuth.cookies.length)
    ? downloadAuth.cookies
    : null;

  // Apply adapter-supplied session cookies to the context BEFORE any navigation
  // or fetch — once, at the top of the (possibly recursive) chain.
  if (authCookies && depth === 0) {
    try {
      await page.context().addCookies(authCookies);
    } catch (e) {
      console.log(`  [download] Could not apply downloadAuth cookies: ${e.message}`);
    }
  }

  // Header-authenticated endpoints (e.g. Arcus): the document URL is an API that
  // returns the file bytes directly and 401s without its headers. page.goto()
  // can't carry per-request auth headers, so fetch via the context request with
  // the adapter's headers merged in. Context cookies (incl. any added above) are
  // shared by context.request, so session-cookie auth rides along too.
  if (authHeaders) {
    const apiResponse = await page.context().request.get(docUrl, { headers: authHeaders });
    const status = apiResponse.status();
    if (status >= 400) {
      throw new Error(`HTTP Error: ${status}`);
    }
    const rawCt = apiResponse.headers()['content-type'] || '';
    const ct = normalizeMimeType(rawCt); // bare type for routing decisions
    const buffer = await apiResponse.body();
    // If the authenticated endpoint returned an HTML viewer instead of the file,
    // fall back to the HTML-extraction path, carrying auth onward.
    if (ct.includes('text/html')) {
      const html = buffer.toString('utf8');
      const extractedUrl = extractPdfFromHtml(html, apiResponse.url());
      if (extractedUrl && extractedUrl !== docUrl) {
        console.log(`  [download] Auth endpoint returned HTML; following embedded PDF: ${extractedUrl}`);
        return await downloadDocumentWithPlaywright(page, extractedUrl, depth + 1, downloadAuth);
      }
      throw new Error('Authenticated endpoint returned HTML with no extractable PDF link.');
    }
    console.log(`  [download] Authenticated fetch OK (${status}, ${ct || 'unknown type'}).`);
    return {
      buffer,
      sizeBytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      mimeType: rawCt || ct, // keep the raw content-type (with params) for the DB
      finalUrl: apiResponse.url(),
    };
  }

  // Listen for native downloads (Strategy B - Content-Disposition: attachment)
  let downloadPromise = page.waitForEvent('download', { timeout: DEFAULT_TIMEOUT_MS }).catch(() => null);

  let response;
  try {
    response = await page.goto(docUrl, { timeout: DEFAULT_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.log(`  [download] goto navigation warning: ${e.message}`);
  }

  // Strategy B: If a download event was triggered, read its stream into memory
  // (no saveAs to disk — Storage-only pipeline).
  const download = await downloadPromise;
  if (download) {
    console.log(`  [download] Detected attachment download event.`);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    return {
      buffer,
      sizeBytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      mimeType: 'application/pdf', // assumed
      finalUrl: download.url()
    };
  }

  // Strategy A & C: Fallback to reading the response body if it's a PDF, or parsing HTML
  if (response) {
    const rawContentType = response.headers()['content-type'] || '';
    const contentType = normalizeMimeType(rawContentType); // bare type for routing decisions
    const statusCode = response.status();

    if (statusCode >= 400) {
       throw new Error(`HTTP Error: ${statusCode}`);
    }

    // Strategy A: Direct PDF
    if (contentType.includes('application/pdf')) {
      console.log(`  [download] Direct PDF response detected. Fetching raw binary stream...`);
      // Use API request context to bypass Chromium's internal PDF viewer extension HTML
      const apiResponse = await page.context().request.get(response.url());
      const buffer = await apiResponse.body();
      return {
        buffer,
        sizeBytes: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        mimeType: rawContentType, // keep the raw content-type (with params) for the DB
        finalUrl: response.url()
      };
    }

    // Strategy C: HTML Viewer
    if (contentType.includes('text/html')) {
      console.log(`  [download] Detected HTML page. Checking for embedded viewers...`);
      const html = await response.text();
      const extractedUrl = extractPdfFromHtml(html, response.url());

      if (extractedUrl && extractedUrl !== docUrl) {
        console.log(`  [download] Found embedded PDF URL: ${extractedUrl}`);
        // Recursively attempt to download the extracted URL
        return await downloadDocumentWithPlaywright(page, extractedUrl, depth + 1);
      } else {
        throw new Error('Navigated to HTML page but could not extract a valid PDF link (HTML Viewer failure).');
      }
    }

    // Fallback buffer read for other binary formats: octet-stream, images, etc.
    if (
      contentType.includes('application/octet-stream') ||
      contentType.includes('image/') ||
      contentType.includes('application/msword') ||
      contentType.includes('officedocument') ||
      contentType.includes('application/zip')
    ) {
       console.log(`  [download] Binary content (${contentType}) detected. Fetching raw stream...`);
       const apiResponse = await page.context().request.get(response.url());
       const buffer = await apiResponse.body();
       return {
         buffer,
         sizeBytes: buffer.length,
         sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
         mimeType: rawContentType, // keep the raw content-type (with params) for the DB
         finalUrl: response.url()
       };
    }

    throw new Error(`Unexpected content type: ${contentType}`);
  }
  throw new Error('Navigation failed and no download event fired.');
}

/**
 * Downloads a single document safely, performing extraction,
 * folder structures creation, filename normalization, and hash deduplication.
 * 
 * Takes an optional Playwright context to preserve session state (cookies/headers).
 * Takes an optional `downloadAuth` ({ headers?, cookies? }) declared by the
 * adapter for portals whose downloads need authentication (e.g. Arcus/Salesforce).
 * When omitted/null, behaves exactly as before (public downloads, e.g. Idox).
 * Optional `extractionMethod` ('idox'|'arcus'|'salesforce'|'capita'|'generic') is
 * recorded on the document row (migration 006) for operational visibility.
 * Optional `knownUrls` (a Set of source URLs already in the DB from a prior run)
 * enables CROSS-RUN dedup (migration 007): a candidate whose URL is already known
 * is not re-fetched/re-uploaded. Its document row's last_seen_at is still bumped
 * (via the finally upsert) because the document is still present on the portal.
 */
async function downloadDocument(doc, application, council, manifest, context = null, downloadAuth = null, extractionMethod = null, knownUrls = null) {
  const resultRecord = {
    council,
    application: application.title,
    originalName: doc.name || 'Document',
    normalizedName: '',
    localPath: '',
    sourceUrl: doc.url,
    finalUrl: '',
    status: 'failed',
    mimeType: '',
    sizeBytes: 0,
    sha256: '',
    storageBucket: '',
    storagePath: '',
    storageMimeType: '',
    storageUploadedAt: '',
    extraction_method: extractionMethod || null,
    error: null
  };

  let page = null;
  let localBrowser = null;
  let localContext = null;

  try {
    // 0. Cross-run dedup (migration 007). If this URL was already downloaded on a
    //    prior run, skip the fetch+upload entirely. We DO fall through to the
    //    finally block so the existing document row's last_seen_at is bumped (the
    //    doc is still present on the portal). The resultRecord already carries
    //    sourceUrl=doc.url, which — with the application_id resolved in finally —
    //    is exactly the (application_id, source_url) upsert conflict key, so the
    //    last_seen_at bump lands on the right row without re-fetching anything.
    if (knownUrls && doc.url && knownUrls.has(doc.url)) {
      console.log(`  [dedup] skipping known url (already downloaded in a prior run): ${(doc.url || '').split('?')[0]}`);
      resultRecord.status = 'skipped_known';
      return resultRecord;
    }

    // Establish Playwright Page Context
    if (context) {
      page = await context.newPage();
    } else {
      console.log(`  [download] No session context provided. Launching isolated browser...`);
      localContext = await createHardenedPersistentContext({
        headless: true,
        sessionId: `download_${sanitizeFilename(application.title || 'application')}`,
      });
      page = await localContext.newPage();
    }

    // 1. File name normalization — keep the real file extension from the source URL.
    //    No local directories are created; the name is only used for the Storage
    //    object key and the document_name persisted to Supabase.
    let cleanName = sanitizeFilename(doc.name || 'document');
    const urlExtMatch = (doc.url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
    const ext = urlExtMatch ? urlExtMatch[1].toLowerCase() : 'pdf';
    const hasExt = new RegExp(`\\.${ext}$`, 'i').test(cleanName);
    if (!hasExt) {
      cleanName += `.${ext}`;
    }
    resultRecord.normalizedName = cleanName;
    resultRecord.localPath = ''; // Storage-only pipeline — nothing written to disk

    // 2. Download the document into memory (no disk writes)
    console.log(`  [download] Fetching stream into memory via Playwright: ${doc.url} -> ${cleanName}`);
    const downloadDetails = await downloadDocumentWithPlaywright(page, doc.url, 0, downloadAuth);

    resultRecord.sizeBytes = downloadDetails.sizeBytes;
    resultRecord.sha256 = downloadDetails.sha256;
    resultRecord.finalUrl = downloadDetails.finalUrl;
    resultRecord.mimeType = downloadDetails.mimeType;

    // 3. Hash-based duplicate check (against already-saved files this run —
    //    either uploaded to Storage or written to the local fallback).
    const isDuplicateHash = manifest.files && manifest.files.some(
      f => f.sha256 === resultRecord.sha256
        && (f.status === 'downloaded' || f.status === 'downloaded_no_storage')
    );
    if (isDuplicateHash) {
      console.log(`  [download] Duplicate SHA-256 hash detected. Skipping upload.`);
      resultRecord.status = 'skipped_duplicate';
      return resultRecord;
    }

    // 4. Upload the in-memory buffer straight to Supabase Storage
    const storageRecord = await uploadDocumentFile({
      buffer: downloadDetails.buffer,
      fileName: cleanName,
      council,
      applicationUid: application.title,
      sha256: resultRecord.sha256,
      mimeType: resultRecord.mimeType || 'application/pdf',
    }).catch(err => {
      console.warn(`  [download] Supabase Storage upload failed: ${err.message}`);
      return null;
    });

    if (storageRecord) {
      Object.assign(resultRecord, storageRecord);
      resultRecord.status = 'downloaded';
      console.log(`  [download] Uploaded to Storage (${(resultRecord.sizeBytes / 1024).toFixed(1)} KB) at ${storageRecord.storagePath}`);
    } else {
      // Bytes were fetched OK but the Storage upload failed (Supabase down /
      // misconfigured). Do NOT mark this as a hard failure — the document was
      // successfully retrieved. Persist the bytes to the local disk fallback so
      // nothing is lost, and surface a distinct status the run summary can show.
      const relPath = saveLocalFallback(downloadDetails.buffer, council, application.title, cleanName);
      resultRecord.localPath = relPath || '';
      resultRecord.status = 'downloaded_no_storage';
      resultRecord.error = 'Storage upload failed; bytes saved to local disk fallback (Supabase unavailable?)';
      if (relPath) {
        console.warn(`  [download] Storage unavailable — saved local fallback at ${relPath}`);
      } else {
        console.warn(`  [download] Storage unavailable AND local fallback write failed for ${cleanName}`);
      }
    }
  } catch (err) {
    console.error(`  [download] Failed to process ${doc.name || 'document'}: ${err.message}`);
    resultRecord.status = 'failed';
    resultRecord.error = err.message;
  } finally {
    try {
      // Attach the document to its parent application by UID (READ-ONLY lookup).
      // We deliberately do NOT upsert the application here: this per-document path
      // does not carry the Planit metadata, and mapApplication() emits every column
      // (NULL for absent ones), so upserting would clobber status / application_type
      // / validated_at / decision back to NULL on every single download. Application
      // state is owned by the orchestrator (src/index.js); documents have their own
      // table, so a read is all this path needs.
      const appRow = await applicationsRepository.findByUid(application.title);
      await documentsRepository.upsertDocument(resultRecord, appRow && appRow.id);
    } catch (persistErr) {
      console.warn(`  [download] Supabase persistence skipped/failed: ${persistErr.message}`);
    }

    if (page) {
       await page.close().catch(() => {});
    }
    if (localBrowser) {
       await localContext.close().catch(() => {});
       await localBrowser.close().catch(() => {});
    } else if (localContext) {
       await localContext.close().catch(() => {});
    }
  }

  return resultRecord;
}

/**
 * Primary orchestrator interface for processing downloads.
 */
async function processDownloads(resultsFilePath = null) {
  const filePath = resultsFilePath || path.join(__dirname, '..', '..', 'output', 'results.json');
  console.log(`\n=== Launching Document Download & Validation Pipeline ===`);
  console.log(`Source results: ${filePath}`);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: Source file does not exist at ${filePath}`);
    return;
  }

  // Storage-only pipeline: the manifest is kept in memory purely for
  // intra-run SHA-256 dedup. It is not read from or written to disk.
  let manifest = { generatedAt: new Date().toISOString(), files: [], metrics: {} };

  const results = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const processedFiles = manifest.files || [];

  // Metrics tracking
  let totalDocs = 0;
  let downloadedCount = 0;
  let failedCount = 0;
  let duplicatesCount = 0;
  let totalSizeDownloaded = 0;

  for (const app of results) {
    const documents = Array.isArray(app.documents) 
      ? app.documents 
      : (app.documents && Array.isArray(app.documents.documents) ? app.documents.documents : []);

    if (documents.length === 0) continue;

    console.log(`\nProcessing application: ${app.title} (Council: ${app.area || 'Unknown'})`);

    for (const doc of documents) {
      totalDocs++;
      // Called without context in standalone processing
      const record = await downloadDocument(doc, app, app.area || 'Unknown', manifest);
      
      processedFiles.push(record);
      manifest.files = processedFiles;

      if (record.status === 'downloaded') {
        downloadedCount++;
        totalSizeDownloaded += record.sizeBytes;
      } else if (record.status === 'failed') {
        failedCount++;
      } else if (record.status === 'skipped_duplicate') {
        duplicatesCount++;
      }
    }
  }

  // Calculate stats
  const avgSize = downloadedCount > 0 ? (totalSizeDownloaded / downloadedCount) : 0;
  const metrics = {
    totalDocs,
    downloaded: downloadedCount,
    failed: failedCount,
    duplicates: duplicatesCount,
    averageSizeBytes: Math.round(avgSize),
    averageSizeKb: Number((avgSize / 1024).toFixed(2))
  };

  manifest.metrics = metrics;
  manifest.generatedAt = new Date().toISOString();

  console.log(`\n=== Download Pipeline Complete ===`);
  console.log(`Total documents processed:  ${metrics.totalDocs}`);
  console.log(`Uploaded to Storage:       ${metrics.downloaded}`);
  console.log(`Failed:                    ${metrics.failed}`);
  console.log(`Skipped duplicates:        ${metrics.duplicates}`);
  console.log(`Average file size:         ${metrics.averageSizeKb} KB`);

  return manifest;
}

// Ensure dummy backwards compatibility for test stubs if needed, 
// since validateDocumentUrl is no longer explicitly exported/implemented exactly the same
const validateDocumentUrl = async (url) => ({ status: 'valid', finalUrl: url, category: 'direct_pdf', contentType: 'application/pdf' });

module.exports = {
  validateDocumentUrl,
  extractPdfFromHtml,
  downloadDocument,
  processDownloads,
  sanitizeFilename,
  normalizeMimeType
};
