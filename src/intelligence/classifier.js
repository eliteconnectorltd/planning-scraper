/**
 * src/intelligence/classifier.js
 *
 * Document category classifier with multi-signal confidence scoring.
 * Signals (in priority order):
 *   1. Type-field direct lookup (highest reliability)
 *   2. Filename regex patterns
 *   3. Document name / description keyword matching
 *   4. PDF text body keyword matching (when available)
 */

const {
  CATEGORIES,
  CATEGORY_RULES,
  FILENAME_PATTERNS,
  TYPE_FIELD_MAP,
  normalise
} = require('./heuristics');

const MAX_CONFIDENCE = 1.0;

/**
 * Score a text string against all keyword rules.
 * Returns a map of { category -> accumulated score }.
 */
function scoreText(text) {
  const scores = {};
  const lower = normalise(text);

  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (lower.includes(kw)) {
        scores[rule.category] = (scores[rule.category] || 0) + rule.weight;
      }
    }
  }
  return scores;
}

/**
 * Score a filename against regex filename patterns.
 * Returns a map of { category -> accumulated score }.
 */
function scoreFilename(filename) {
  const scores = {};
  for (const entry of FILENAME_PATTERNS) {
    if (entry.pattern.test(filename)) {
      scores[entry.category] = (scores[entry.category] || 0) + entry.weight;
    }
  }
  return scores;
}

/**
 * Merge score maps, summing matching categories.
 */
function mergeScores(...maps) {
  const merged = {};
  for (const map of maps) {
    for (const [cat, score] of Object.entries(map)) {
      merged[cat] = (merged[cat] || 0) + score;
    }
  }
  return merged;
}

/**
 * Pick the best category and compute a normalised confidence.
 * Confidence = winning score / (winning score + second score + 1).
 * Result is clamped to [0, 1].
 */
function pickBestCategory(scores) {
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    return { category: CATEGORIES.UNKNOWN, confidence: 0.0 };
  }

  const [topCat, topScore] = entries[0];
  const secondScore = entries[1] ? entries[1][1] : 0;

  // Normalised confidence: how dominant is the top score?
  const raw = topScore / (topScore + secondScore + 1);
  const confidence = Math.min(MAX_CONFIDENCE, Number(raw.toFixed(3)));

  return { category: topCat, confidence };
}

/**
 * Primary classification function.
 *
 * @param {object} doc      - Document record with { name, type, url, ... }
 * @param {string} pdfText  - Extracted PDF text (may be empty/null)
 * @returns {{ category: string, confidence: number, signals: string[] }}
 */
function classifyDocument(doc, pdfText = '') {
  const signals = [];

  // ── Signal 1: Type-field direct lookup ────────────────────────────────────
  const typeKey = normalise(doc.type || '');
  if (typeKey && TYPE_FIELD_MAP[typeKey]) {
    const mapped = TYPE_FIELD_MAP[typeKey];
    signals.push(`type_field_match:"${doc.type}"`);
    return {
      category: mapped,
      confidence: 0.95,   // Direct lookup is very reliable
      signals
    };
  }

  // ── Signal 2: Filename regex ───────────────────────────────────────────────
  const filenameScores = scoreFilename(doc.name || '');
  if (Object.keys(filenameScores).length > 0) {
    signals.push('filename_pattern_match');
  }

  // ── Signal 3: Document name keyword matching ───────────────────────────────
  const nameScores = scoreText(doc.name || '');
  if (Object.keys(nameScores).length > 0) {
    signals.push('name_keyword_match');
  }

  // ── Signal 4: PDF body text keyword matching ──────────────────────────────
  let textScores = {};
  if (pdfText && pdfText.length > 50) {
    // Only score first 2000 chars for speed (title/header area)
    textScores = scoreText(pdfText.slice(0, 2000));
    if (Object.keys(textScores).length > 0) {
      signals.push('pdf_text_keyword_match');
    }
  }

  // Filename signals carry 2× weight
  const boostedFilenameScores = {};
  for (const [cat, score] of Object.entries(filenameScores)) {
    boostedFilenameScores[cat] = score * 2;
  }

  const merged = mergeScores(boostedFilenameScores, nameScores, textScores);
  const { category, confidence } = pickBestCategory(merged);

  // Low-confidence fallback to Supporting Document before Unknown
  if (confidence < 0.15) {
    return {
      category: CATEGORIES.SUPPORTING_DOCUMENT,
      confidence: 0.10,
      signals: signals.length ? signals : ['fallback']
    };
  }

  return { category, confidence, signals };
}

module.exports = { classifyDocument };
