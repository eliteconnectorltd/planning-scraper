'use strict';

/**
 * timelineBuilder.js
 * Generates chronological timeline events for a planning application
 * based on its documents and extracted intelligence.
 */

// Simple keyword list + specific rev-letter regex (avoids \b failures on underscored filenames)
const REVISION_KEYWORDS = ['revised', 'amendment', 'amended'];
const REVISION_REV_PATTERN = /(?:^|[^a-zA-Z])rev(?:ision)?[\s._-]?([a-z])(?![a-zA-Z])/i;
const PLAN_TYPES = ['floor plan', 'site plan', 'elevation', 'section', 'block plan', 'layout', 'drawing'];
const DECISION_NOTICE_TYPES = ['decision notice', 'appeal decision', 'officer report', 'planning decision'];

/**
 * Detect whether a document name/type looks like a revised drawing.
 * @param {string} name
 * @param {string} [docType]
 * @returns {boolean}
 */
function isRevisedDrawing(name = '', docType = '') {
  const combined = `${name} ${docType}`.toLowerCase();
  if (REVISION_KEYWORDS.some(k => combined.includes(k))) return true;
  return REVISION_REV_PATTERN.test(combined);
}

/**
 * Detect whether a document represents a decision notice.
 * @param {string} name
 * @param {string} [docType]
 * @returns {boolean}
 */
function isDecisionNotice(name = '', docType = '') {
  const combined = `${name} ${docType}`.toLowerCase();
  return DECISION_NOTICE_TYPES.some(t => combined.includes(t));
}

/**
 * Detect whether a document represents a plan/drawing upload.
 * @param {string} name
 * @param {string} [docType]
 * @returns {boolean}
 */
function isPlanDocument(name = '', docType = '') {
  const combined = `${name} ${docType}`.toLowerCase();
  return PLAN_TYPES.some(t => combined.includes(t));
}

/**
 * Parse a date string safely; return null if invalid.
 * @param {string} dateStr
 * @returns {string|null}  ISO date string or null
 */
function safeDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

/**
 * Build a timeline event object.
 * @param {string} type
 * @param {string} date
 * @param {string} description
 * @param {object} [meta]
 * @returns {object}
 */
function makeEvent(type, date, description, meta = {}) {
  return { type, date: safeDate(date) || date, description, ...meta };
}

/**
 * Build the full chronological timeline for a single application.
 *
 * @param {object} application  - Raw scraper record (from results.json)
 * @param {object[]} [documents] - Array of document objects (may include date, name, type fields)
 * @param {object} [intelligence] - Intelligence payload (optional, from intelligence pipeline)
 * @returns {object[]}  Sorted array of timeline events
 */
function buildTimeline(application, documents = [], intelligence = null) {
  const events = [];

  // ── 1. Application submitted
  const submitDate = application.startDate || application.decision_date || null;
  if (submitDate) {
    events.push(makeEvent(
      'application_submitted',
      submitDate,
      `Application ${application.title || application.application_id} submitted to ${application.area || application.council}.`,
      { application_id: application.title || application.application_id }
    ));
  }

  // ── 2. Per-document events
  for (const doc of documents) {
    const docName = doc.name || doc.title || doc.filename || '';
    const docType = doc.type || doc.category || doc.documentType || '';
    const docDate = doc.date || doc.received_date || doc.createdDate || null;
    const effectiveDate = safeDate(docDate) || submitDate;

    if (!effectiveDate) continue;

    if (isDecisionNotice(docName, docType)) {
      events.push(makeEvent(
        'decision_issued',
        effectiveDate,
        `Decision notice received: "${docName || docType}".`,
        { document_name: docName, document_type: docType }
      ));
    } else if (isRevisedDrawing(docName, docType)) {
      events.push(makeEvent(
        'revised_drawings_added',
        effectiveDate,
        `Revised drawings uploaded: "${docName || docType}".`,
        { document_name: docName, document_type: docType }
      ));
    } else if (isPlanDocument(docName, docType)) {
      events.push(makeEvent(
        'new_plans_uploaded',
        effectiveDate,
        `Plans uploaded: "${docName || docType}".`,
        { document_name: docName, document_type: docType }
      ));
    }
  }

  // ── 3. Decision event from intelligence or application record
  const decision = application.decision || (intelligence && intelligence.decision);
  const decisionDate = application.decision_date || (intelligence && intelligence.decision_date);
  if (decision && decisionDate) {
    events.push(makeEvent(
      'decision_issued',
      decisionDate,
      `Decision: ${decision}.`,
      { decision }
    ));
  }

  // ── 4. Deduplicate and sort chronologically
  const seen = new Set();
  const unique = events.filter(e => {
    const key = `${e.type}|${e.date}|${e.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => {
    const da = new Date(a.date);
    const db = new Date(b.date);
    if (isNaN(da) && isNaN(db)) return 0;
    if (isNaN(da)) return 1;
    if (isNaN(db)) return -1;
    return da - db;
  });

  return unique;
}

module.exports = { buildTimeline, makeEvent, isRevisedDrawing, isDecisionNotice, isPlanDocument, safeDate };
