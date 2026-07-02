/**
 * adapters/idox.js
 *
 * Ultra-resilient, production-grade scraper for Idox-based council portals.
 * Hardened to handle diverse layouts, alternate tables, missing headers,
 * merged cells, slow portals, duplicate detection, and adaptive timeouts.
 */

const fs = require('fs');
const path = require('path');
const { getOverrideForUrl } = require('./idox_overrides');
const { classifyChallenge } = require('../browserChallenges');

/**
 * Normalizes and canonicalizes document download URLs.
 * Orders query parameters alphabetically to reliably detect duplicates where order differs.
 *
 * @param {string} rawUrl - Relative or absolute link
 * @param {string} baseUrl - Current page URL context
 * @returns {string|null} - Canonical absolute URL
 */
function canonicalizeUrl(rawUrl, baseUrl) {
  if (!rawUrl) return null;
  try {
    const absolute = new URL(rawUrl, baseUrl);

    // Sort query parameters to ensure deterministic duplicate detection
    const params = Array.from(absolute.searchParams.entries());
    params.sort((a, b) => a[0].localeCompare(b[0]));

    // Reconstruct query string
    const newSearchParams = new URLSearchParams();
    for (const [key, val] of params) {
      // Remove standard tab navigation query params that don't belong to the file itself
      if (key.toLowerCase() !== 'activetab') {
        newSearchParams.set(key, val);
      }
    }

    absolute.search = newSearchParams.toString();
    return absolute.href;
  } catch (err) {
    return null;
  }
}

/**
 * 1. Reliably navigates to and opens the Documents tab.
 * Supports adaptive timeouts, slow portals, retries, and overrides.
 *
 * @param {import('playwright').Page} page - Playwright page object
 * @param {string} url - Target portal URL
 * @param {object} override - Council override config
 */
async function openDocumentsTab(page, url, override = null) {
  const timeout = override?.customWaitMs || 45000;
  console.log(`[idox] [openDocumentsTab] Opening page: ${url} (Adaptive timeout: ${timeout}ms)`);

  // Navigate using a hybrid networkidle/domcontentloaded strategy
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (err) {
    console.log(`[idox] [openDocumentsTab] Navigation warning (domcontentloaded timeout): ${err.message}. Retrying with networkidle...`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    } catch (e) {
      console.log(`[idox] [openDocumentsTab] Retry failed: ${e.message}. Attempting to proceed anyway.`);
    }
  }

  // Brief stabilization wait
  await page.waitForTimeout(2000);

  const challenge = await classifyChallenge(page, new URL(url).hostname).catch(() => ({ blocked: false }));
  if (challenge.blocked) {
    const err = new Error(`Portal blocked by managed challenge: ${challenge.reason || 'unknown challenge'}`);
    err.code = 'BLOCKED';
    err.challenge = challenge;
    throw err;
  }

  // Check if we are already active on the documents section
  const isDocTabActive = await page.evaluate(() => {
    const activeTab = document.querySelector('li.active, li.selected, th.active, td.active, .tab.active');
    if (activeTab && activeTab.innerText.toLowerCase().includes('document')) {
      return true;
    }
    return window.location.href.toLowerCase().includes('activetab=documents');
  });

  if (isDocTabActive) {
    console.log('[idox] [openDocumentsTab] Documents tab is already active');
    return true;
  }

  // Attempt to transition to Documents tab
  const tabSelector = override?.tabSelector || '#subtab_documents';
  console.log(`[idox] [openDocumentsTab] Transitioning to Documents tab. Trying override or custom selectors...`);

  const selectors = [
    tabSelector,
    '#documents',
    '#subtab_documents',
    'a[href*="activeTab=documents"]',
    'text=Documents',
    'a:has-text("Documents")'
  ];

  let clicked = false;
  for (const selector of selectors) {
    try {
      const tab = page.locator(selector).first();
      if (await tab.isVisible()) {
        console.log(`[idox] [openDocumentsTab] Clicking tab via: "${selector}"`);
        await tab.click();
        clicked = true;
        break;
      }
    } catch (e) {
      // Try next
    }
  }

  if (!clicked) {
    console.log('[idox] [openDocumentsTab] Click selectors failed. Attempting direct navigation...');
    const directUrl = await page.evaluate(() => {
      const a = document.querySelector('a[href*="activeTab=documents"]');
      return a ? a.href : null;
    });

    if (directUrl) {
      await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout });
    } else {
      // Manual URL query injection
      const joiner = url.includes('?') ? '&' : '?';
      const fallbackUrl = url.includes('activeTab=')
        ? url.replace(/activeTab=[^&]+/, 'activeTab=documents')
        : `${url}${joiner}activeTab=documents`;

      console.log(`[idox] [openDocumentsTab] Navigating to manual URL: ${fallbackUrl}`);
      await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout });
    }
  }

  // Wait for documents to load dynamically
  try {
    await Promise.race([
      page.waitForSelector('table#documents', { timeout: 10000 }),
      page.waitForSelector('table.aTable', { timeout: 10000 }),
      page.waitForTimeout(5000)
    ]);
  } catch (err) {
    console.log(`[idox] [openDocumentsTab] Table load timeout: ${err.message}`);
  }

  return true;
}

/**
 * 2. Extracts document rows from the page table.
 * Super resilient: handles alternate table structures, missing headers,
 * and cells merged using colspan or rowspan.
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {object} override - Council override config
 * @returns {Promise<object>} - Raw extracted rows and metrics
 */
async function extractDocumentRows(page, override = null) {
  console.log('[idox] [extractDocumentRows] Initiating row extraction...');

  const customTableSelector = override?.tableSelector || null;

  return await page.evaluate((tableSelectorOverride) => {
    // 1. Locate the document table
    let table = null;

    if (tableSelectorOverride) {
      table = document.querySelector(tableSelectorOverride);
    }

    if (!table) {
      for (const sel of ['table#documents', 'table.aTable', 'table[summary*="documents"]']) {
        const el = document.querySelector(sel);
        if (el) { table = el; break; }
      }
    }

    if (!table) {
      // Generic table containing document view endpoints
      const allTables = Array.from(document.querySelectorAll('table'));
      table = allTables.find(t => {
        const html = t.innerHTML.toLowerCase();
        return html.includes('showdocument.do') || html.includes('documentdetails.do') || html.includes('date published');
      });
    }

    if (!table) {
      return { source: 'none', rows: [] };
    }

    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) {
      return { source: 'none', rows: [] };
    }

    // 2. Map table headers to calculate column indices dynamically
    const headerEl = table.querySelector('thead tr, tr:first-child');
    const headers = headerEl
      ? Array.from(headerEl.querySelectorAll('th, td')).map(h => h.innerText.trim().toLowerCase())
      : [];

    let dateIdx = headers.findIndex(h => h.includes('date') || h.includes('published'));
    let typeIdx = headers.findIndex(h => h.includes('type') || h.includes('category'));
    let descIdx = headers.findIndex(h => h.includes('description') || h.includes('title') || h.includes('proposal') || h.includes('name'));
    let linkIdx = headers.findIndex(h => h.includes('view') || h.includes('download') || h.includes('link') || h.includes('document'));

    // Safe default fallbacks if headers are completely missing
    if (dateIdx === -1) dateIdx = 0;
    if (typeIdx === -1) typeIdx = 1;
    if (descIdx === -1) descIdx = 2;
    if (linkIdx === -1) linkIdx = headers.length > 3 ? 3 : headers.length - 1;

    const results = [];
    const startRowIdx = (table.querySelector('thead') || headers.length === 0) ? 0 : 1;

    for (let i = startRowIdx; i < rows.length; i++) {
      const row = rows[i];
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length === 0) continue; // Skip header row

      // Prefer the actual View/Download document link. Some IDOX tables include
      // a Measure column before View; taking the first anchor drops drawings.
      const anchors = Array.from(row.querySelectorAll('a')).filter(a => a.href);
      const scoreAnchor = (anchor) => {
        const href = anchor.href.toLowerCase();
        const label = `${anchor.innerText || ''} ${anchor.title || ''} ${anchor.getAttribute('aria-label') || ''}`.toLowerCase();

        if (href.includes('showdocument.do') || href.includes('documentdetails.do') || href.includes('viewdocument.do')) return 100;
        if (href.includes('/files/') || href.includes('/pdf/') || href.endsWith('.pdf')) return 90;
        if (href.includes('download') || label.includes('download') || label.includes('view')) return 80;
        if (href.includes('keyval=') || href.includes('docid=')) return 50;
        if (href.includes('omt-server') || href.includes('omt.html') || href.includes('#dockey') || label.includes('measure')) return -100;
        return 0;
      };
      const link = anchors
        .map(anchor => ({ anchor, score: scoreAnchor(anchor) }))
        .sort((a, b) => b.score - a.score)[0]?.anchor;
      if (!link || !link.href) continue;

      // Safe access using shifts if cell arrays are shorter due to colspan
      const getCellText = (idx) => {
        if (idx === -1 || idx >= cells.length) return '';
        // If cell has colspan, just grab its text
        return cells[idx] ? cells[idx].innerText.trim() : '';
      };

      const rawDate = getCellText(dateIdx);
      const rawType = getCellText(typeIdx);
      const rawDesc = getCellText(descIdx);

      const linkText = link.innerText.trim();
      const docName = linkText && !['view', 'download', 'pdf'].includes(linkText.toLowerCase())
        ? linkText
        : (rawDesc || 'Document');

      results.push({
        rawName: docName,
        rawType: rawType,
        rawDate: rawDate,
        rawUrl: link.href
      });
    }

    return {
      source: 'table',
      rows: results
    };
  }, customTableSelector);
}

/**
 * 3. Normalizes document metadata, filters non-documents, and deduplicates links.
 *
 * @param {object} rawDoc - Raw row record
 * @param {string} baseUrl - Base URL page context
 * @returns {object|null} - Normalized document
 */
function getConfidence(docUrl, rawName) {
  const lower = docUrl.toLowerCase();
  // HIGH: direct PDF links or obvious document viewers ending with .pdf
  if (lower.endsWith('.pdf')) return 'HIGH';
  // MEDIUM: known Idox viewer patterns
  if (lower.includes('showdocument.do') || lower.includes('documentdetails.do') || lower.includes('viewdocument.do')) return 'MEDIUM';
  // LOW: tokenized routes or relative paths that look like docs
  if (lower.includes('keyval=') || lower.includes('docid=') || lower.includes('token=')) return 'LOW';
  // SYSTEM_LINK: navigation or non-document links
  return 'SYSTEM_LINK';
}

function normalizeDocument(rawDoc, baseUrl) {
  if (!rawDoc || !rawDoc.rawUrl) return null;

  // Resolve and canonicalize relative URLs
  const canonicalUrl = canonicalizeUrl(rawDoc.rawUrl, baseUrl);
  if (!canonicalUrl) return null;

  const urlLower = canonicalUrl.toLowerCase();

  // Filter out obvious navigation / system links (login, search, javascript, fragment, etc.)
  const isSystemLink =
    urlLower.includes('activetab=') ||
    urlLower.includes('action=') ||
    urlLower.includes('/search.do') ||
    urlLower.includes('/login.do') ||
    urlLower.includes('javascript:') ||
    urlLower.includes('#') ||
    rawDoc.rawName.toLowerCase() === 'home' ||
    rawDoc.rawName.toLowerCase() === 'help';
  if (isSystemLink) return null;

  // Basic sanity: must have a name and a link (already ensured by rawUrl check)
  const name = rawDoc.rawName && rawDoc.rawName.trim() ? rawDoc.rawName.trim() : 'Document';
  const type = rawDoc.rawType && rawDoc.rawType.trim() ? rawDoc.rawType.trim() : 'Document';
  const date = rawDoc.rawDate && rawDoc.rawDate.trim() ? rawDoc.rawDate.trim() : null;

  const confidence = getConfidence(canonicalUrl, name);

  return {
    name,
    type,
    date,
    url: canonicalUrl,
    confidence,
  };
}

// ── Contact / decision metadata (Details, Summary and Dates tabs) ─────────────
// Idox splits application metadata across tabs: applicant/agent/case officer live
// on the "Details" tab; decision + dates on "Summary"; consultation/target dates
// on "Dates". The document scraper only visits the Documents tab, so these fields
// were never captured (applicant/agent/case_officer/decision were 0/81 in dev).
//
// Extraction is pure-regex over the tab HTML. Idox renders label/value pairs in
// three shapes across skins: <th>Label</th><td>Value</td>, <td>Label</td><td>Value</td>,
// and <dt>Label</dt><dd>Value</dd>. The label is anchored to its CLOSING tag (after
// an optional colon) so "Agent" cannot match an "Agent Name"/"Agent's Address" cell.
// CAVEAT: labels vary by council skin; verified label set below is a best-effort
// union — re-check when onboarding a new Idox council (no per-council code here).

const IDOX_PLACEHOLDER = /^(?:-+|—|n\/?a|not\s+available|not\s+yet\s+available|none|tbc|unknown)$/i;

/** Strip tags/entities, collapse whitespace; return null for empty/placeholder text. */
function cleanFieldValue(raw) {
  if (raw == null) return null;
  const text = String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || IDOX_PLACEHOLDER.test(text)) return null;
  return text;
}

/**
 * First labelled value in `html` matching any of `labels` (case-insensitive),
 * trying th/td, td/td and dt/dd cell pairs. Returns cleaned string or null.
 */
function labeledValue(html, labels) {
  // Decode the entities that appear inside LABELS (apostrophe, ampersand, nbsp) so a
  // label like "Agent's Address" matches markup rendered as "Agent&#39;s Address".
  const decoded = String(html || '')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ');
  const alt = labels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|');
  const label = `(?:${alt})`;
  const patterns = [
    new RegExp(`<th\\b[^>]*>\\s*${label}\\s*:?\\s*</th>\\s*<td\\b[^>]*>([\\s\\S]*?)</td>`, 'i'),
    new RegExp(`<td\\b[^>]*>\\s*${label}\\s*:?\\s*</td>\\s*<td\\b[^>]*>([\\s\\S]*?)</td>`, 'i'),
    new RegExp(`<dt\\b[^>]*>\\s*${label}\\s*:?\\s*</dt>\\s*<dd\\b[^>]*>([\\s\\S]*?)</dd>`, 'i'),
  ];
  for (const re of patterns) {
    const m = decoded.match(re);
    if (m) {
      const val = cleanFieldValue(m[1]);
      if (val) return val;
    }
  }
  return null;
}

/**
 * Parse Idox contact/decision fields from concatenated tab HTML.
 * Keys follow the adapter metadata convention consumed by index.js adapterContacts.
 * @param {string} html
 * @returns {{applicant_name, agent_name, agent_company, agent_address, case_officer, decision, target_decision_date, consultation_start_date}}
 */
function parseIdoxContactFields(html) {
  const h = String(html || '');
  return {
    applicant_name: labeledValue(h, ['Applicant Name', 'Applicant']),
    agent_name: labeledValue(h, ['Agent Name', 'Agent']),
    agent_company: labeledValue(h, ["Agent Company", "Agent's Company", 'Company Name']),
    agent_address: labeledValue(h, ["Agent's Address", 'Agent Address']),
    case_officer: labeledValue(h, ['Case Officer Name', 'Case Officer']),
    decision: labeledValue(h, ['Decision', 'Decision Made']),
    target_decision_date: labeledValue(h, ['Target Decision Date', 'Determination Deadline', 'Target Date', 'Expiry Date']),
    consultation_start_date: labeledValue(h, ['Consultation Start Date', 'Consultation Period Begins', 'Neighbour Consultation Start']),
  };
}

/** Rewrite an application URL to a specific Idox activeTab. */
function idoxTabUrl(url, tab) {
  const joiner = url.includes('?') ? '&' : '?';
  return /activeTab=/i.test(url)
    ? url.replace(/activeTab=[^&]+/i, `activeTab=${tab}`)
    : `${url}${joiner}activeTab=${tab}`;
}

/**
 * Best-effort: visit the metadata tabs and return concatenated HTML for parsing.
 * Runs AFTER document extraction (navigates the page away from Documents). Never
 * throws — any tab that fails is simply skipped; contact fields are supplementary.
 */
async function collectIdoxContactHtml(page, url) {
  let html = '';
  for (const tab of ['summary', 'details', 'dates']) {
    try {
      await page.goto(idoxTabUrl(url, tab), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(500);
      html += '\n' + (await page.content());
    } catch (err) {
      console.log(`[idox] [contacts] Tab "${tab}" fetch skipped: ${err.message}`);
    }
  }
  return html;
}

/**
 * Captures screenshots, DOM snapshots, and HTML code on extraction failures.
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {string} identifier - Safe name segment
 */
async function saveDebugAssets(page, identifier) {
  const debugDir = path.join(__dirname, '..', '..', 'debug');
  try {
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }

    const safeId = identifier.replace(/[^a-zA-Z0-9]/g, '_');
    const timestamp = Date.now();

    // 1. HTML content snapshot
    const html = await page.content();
    fs.writeFileSync(path.join(debugDir, `fail_${safeId}_${timestamp}.html`), html, 'utf8');

    // 2. Full-page screenshot
    await page.screenshot({ path: path.join(debugDir, `fail_${safeId}_${timestamp}.png`), fullPage: true });

    // 3. Save DOM tree structure dump for debugging selectors
    const domDump = await page.evaluate(() => {
      const dump = [];
      const tables = document.querySelectorAll('table');
      dump.push(`Total tables: ${tables.length}`);
      tables.forEach((t, idx) => {
        dump.push(`\n--- TABLE ${idx} (id: "${t.id}", class: "${t.className}") ---`);
        const rows = t.querySelectorAll('tr');
        dump.push(`Rows: ${rows.length}`);
        if (rows[0]) {
          dump.push(`Headers: ${rows[0].innerText.replace(/\n/g, ' | ')}`);
        }
      });
      return dump.join('\n');
    });
    fs.writeFileSync(path.join(debugDir, `fail_${safeId}_${timestamp}_dom.txt`), domDump, 'utf8');

    console.log(`[idox] [DEBUG] Saved fail assets for: ${safeId} -> /debug`);
  } catch (err) {
    console.log(`[idox] [DEBUG] Failed to save assets: ${err.message}`);
  }
}

/**
 * Main orchestrator for Idox extraction.
 * Processes rows, canonicalizes, deduplicates, and compiles extraction metrics.
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {string} url - Target portal URL
 * @returns {Promise<object>} - `{ documents: [], metrics: {} }`
 */
async function scrapeIdoxDocuments(page, url) {
  console.log(`\n[idox] Launching production-grade extraction for: ${url}`);

  const override = getOverrideForUrl(url);

  let success = false;
  let rawData = { source: 'none', rows: [] };
  let errorMsg = null;
  const startTime = Date.now();

  try {
    // 1. Open the documents tab with adaptive timeouts
    console.log(`[idox] [step 1/3] Opening documents tab (navigation + challenge check): ${url}`);
    success = await openDocumentsTab(page, url, override);
    console.log(`[idox] [step 1/3] Documents tab opened (success=${success})`);
    if (success) {
      // 2. Resilient row extraction
      console.log('[idox] [step 2/3] Extracting document rows from table');
      rawData = await extractDocumentRows(page, override);
      console.log(`[idox] [step 2/3] Row extraction returned ${rawData.rows.length} raw row(s) (source=${rawData.source})`);
    }
  } catch (err) {
    errorMsg = err.message;
    console.log(`[idox] Orchestration error: ${err.message}`);
  }

  const runDuration = Date.now() - startTime;
  const totalRows = rawData.rows.length;

  // Deduplication map
  const seenUrls = new Set();
  const validDocs = [];

  let duplicateDocsCount = 0;
  let filteredRowsCount = 0;

  // 3. Normalize, filter system links, and deduplicate document records
  const filteredDiagnostics = [];
  for (const rawRow of rawData.rows) {
    const doc = normalizeDocument(rawRow, url);
    if (!doc) {
      // Determine reason for filtering
      let reason = 'SYSTEM_LINK';
      if (rawRow.rawName && rawRow.rawName.toLowerCase().includes('terms')) reason = 'TERMS_LINK';
      else if (rawRow.rawName && rawRow.rawName.toLowerCase().includes('privacy')) reason = 'PRIVACY_LINK';
      else if (rawRow.rawName && rawRow.rawName.toLowerCase().includes('cookies')) reason = 'COOKIES_LINK';
      filteredDiagnostics.push({ title: rawRow.rawName, url: rawRow.rawUrl, reason });
      filteredRowsCount++;
      continue;
    }

    if (seenUrls.has(doc.url)) {
      duplicateDocsCount++;
      continue;
    }

    seenUrls.add(doc.url);
    validDocs.push(doc);
  }

  const metrics = {
    totalRows,
    validDocs: validDocs.length,
    filteredRows: filteredRowsCount,
    filteredDiagnostics,
    duplicateDocs: duplicateDocsCount,
    runtimeMs: runDuration,
    success: success && (totalRows > 0 || validDocs.length > 0)
  };

  console.log(`[idox] Extraction Complete (${runDuration}ms). Metrics:`);
  console.log(`[idox]   Total Rows Found:  ${totalRows}`);
  console.log(`[idox]   Valid Documents:   ${validDocs.length}`);
  console.log(`[idox]   Filtered Rows:     ${filteredRowsCount}`);
  console.log(`[idox]   Filtered Diagnostics:`);
  filteredDiagnostics.forEach(d => {
    console.log(`      - ${d.title || 'Unnamed'} | ${d.url} | Reason: ${d.reason}`);
  });
  console.log(`[idox]   Duplicate Links:   ${duplicateDocsCount}`);

  // Auto debug triggers if documents could not be pulled
  if (!metrics.success || validDocs.length === 0) {
    console.log('[idox] Extraction yielded zero valid documents. Triggering debug snap...');
    const domainSegment = new URL(url).hostname.replace(/\./g, '_');
    await saveDebugAssets(page, domainSegment);
  }

  // Contact/decision metadata from the Details/Summary/Dates tabs (best-effort;
  // supplementary to documents — never fails the scrape). Done LAST because it
  // navigates the page away from the Documents tab.
  let metadata = null;
  try {
    console.log('[idox] [step 3/3] Collecting contact metadata (summary/details/dates tabs)');
    const contactHtml = await collectIdoxContactHtml(page, url);
    metadata = parseIdoxContactFields(contactHtml);
    const found = Object.entries(metadata).filter(([, v]) => v).map(([k]) => k);
    console.log(`[idox] Contact fields extracted: ${found.length ? found.join(', ') : 'none'}`);
  } catch (err) {
    console.log(`[idox] Contact field extraction skipped: ${err.message}`);
  }

  return {
    documents: validDocs,
    metrics,
    metadata: metadata || undefined,
  };
}

module.exports = {
  canonicalizeUrl,
  openDocumentsTab,
  extractDocumentRows,
  normalizeDocument,
  scrapeIdoxDocuments,
  saveDebugAssets,
  // exported for unit tests:
  parseIdoxContactFields,
  labeledValue,
  cleanFieldValue,
  idoxTabUrl,
};
