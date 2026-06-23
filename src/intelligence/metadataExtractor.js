/**
 * src/intelligence/metadataExtractor.js
 *
 * Extracts structured planning-intelligence fields from PDF text and
 * document/application context. All extraction is regex-based — no AI/APIs.
 *
 * Fields extracted:
 *   applicationRef, proposal, decision, decisionDate,
 *   address, applicant, council
 */

const { METADATA_PATTERNS, normalise } = require('./heuristics');

/**
 * Tries each regex in an array against text, returns first match group 1.
 */
function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      const val = (m[1] || m[0] || '').trim();
      if (val.length > 1) return val;
    }
  }
  return null;
}

/**
 * Determines grant/refuse decision from text.
 * Returns 'GRANTED', 'REFUSED', or null.
 */
function extractDecisionStatus(text) {
  const lower = text.toLowerCase();
  const granted = [
    'permission is granted', 'hereby granted', 'is approved',
    'planning permission granted', 'permitted development', 'grant of planning',
    'approval is given', 'approval is granted'
  ];
  const refused = [
    'is refused', 'hereby refused', 'permission is refused',
    'application is refused', 'be refused'
  ];

  for (const phrase of granted) {
    if (lower.includes(phrase)) return 'GRANTED';
  }
  for (const phrase of refused) {
    if (lower.includes(phrase)) return 'REFUSED';
  }
  return null;
}

/**
 * Extracts structured metadata from PDF text + existing application context.
 *
 * @param {string}  pdfText    - Extracted PDF text (may be empty)
 * @param {object}  doc        - Scraped document record { name, type, url, date }
 * @param {object}  appContext - Parent application record { title, area, address, description }
 * @returns {object} - Structured metadata record
 */
function extractMetadata(pdfText = '', doc = {}, appContext = {}) {
  const text = pdfText || '';

  // ── Try to extract from PDF text ──────────────────────────────────────────
  const fromPdf = {
    applicationRef: firstMatch(text, METADATA_PATTERNS.applicationRef),
    proposal:       firstMatch(text, METADATA_PATTERNS.proposal),
    decision:       extractDecisionStatus(text),
    decisionDate:   firstMatch(text, METADATA_PATTERNS.decisionDate),
    address:        firstMatch(text, METADATA_PATTERNS.address),
    applicant:      firstMatch(text, METADATA_PATTERNS.applicant)
  };

  // ── Merge with application context (context fills blanks) ────────────────
  const merged = {
    applicationRef: fromPdf.applicationRef || appContext.title || null,
    proposal:       fromPdf.proposal       || appContext.description || null,
    decision:       fromPdf.decision       || null,
    decisionDate:   fromPdf.decisionDate   || doc.date || null,
    address:        fromPdf.address        || appContext.address || null,
    applicant:      fromPdf.applicant      || null,
    council:        appContext.area        || null
  };

  // Clean extracted strings
  for (const key of Object.keys(merged)) {
    if (typeof merged[key] === 'string') {
      merged[key] = merged[key].replace(/\s+/g, ' ').trim();
      if (merged[key].length === 0) merged[key] = null;
    }
  }

  return merged;
}

module.exports = { extractMetadata };
