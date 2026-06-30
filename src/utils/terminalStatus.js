'use strict';

/**
 * src/utils/terminalStatus.js
 *
 * Single source of truth for deciding whether a planning application has reached
 * a TERMINAL state (decision issued / withdrawn / disposed) and therefore should
 * NOT be re-checked daily for new documents.
 *
 * Used by:
 *   - the orchestrator (src/index.js) — to skip re-checking terminal applications
 *   - applicationsRepository.mapApplication — to set applications.is_terminal
 *
 * SAFER DEFAULT: an unknown / unlisted / null status is treated as ACTIVE
 * (returns false). Re-checking an already-finished application wastes a little
 * work; skipping a still-live one would silently miss new documents. We err
 * toward re-checking.
 */

// Lowercased, trimmed exact matches. Planit/portal statuses vary in wording, so
// both the bare verb and the "Application <verb>" forms are included.
const TERMINAL_STATUSES = new Set([
  'decided',
  'refused',
  'granted',
  'permitted',
  'approved',
  'withdrawn',
  'application withdrawn',
  'decision issued',
  'application permitted',
  'application refused',
  'application granted',
  'finally disposed of',
  // Added from Phase 3c era testing (docs/era-testing-results.md): Wandsworth's
  // Northgate/Capita portal reports decided applications as "Final Decision"
  // (verified across 2018/0500, 2020/3000, 2021/4000, 2022/3000, 2023/4015).
  // Without this, decided Wandsworth apps never flip is_terminal=true and would be
  // re-checked daily forever — defeating Pattern C for the one verified council.
  'final decision',
]);

/**
 * @param {string|null|undefined} status
 * @returns {boolean} true only when `status` is a known terminal value.
 */
function isTerminalStatus(status) {
  if (!status) return false; // null/empty = active by default (safer to re-check)
  return TERMINAL_STATUSES.has(String(status).trim().toLowerCase());
}

module.exports = { isTerminalStatus, TERMINAL_STATUSES };
