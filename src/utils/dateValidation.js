'use strict';

/**
 * src/utils/dateValidation.js
 *
 * Resolves the Planit feed window from env config. Two modes:
 *   - rolling: the existing "last N days" behaviour (recent=<N>)
 *   - range:   absolute START_DATE..END_DATE (start_date__gte / __lte)
 *
 * Dates are treated as UTC calendar days (no time-of-day, no local tz) — the same
 * convention Planit's `recent` window uses. Backward compatible: with neither
 * START_DATE nor END_DATE set, callers get rolling mode and unchanged behaviour.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as a YYYY-MM-DD UTC string. */
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse a strict YYYY-MM-DD string to a UTC Date, or null if malformed/impossible.
 * Rejects values that look right but don't exist (e.g. 2024-02-31) via round-trip.
 * @param {string} str
 * @returns {Date|null}
 */
function parseDate(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== s) return null; // calendar rollover guard
  return d;
}

/** Add `delta` days to a YYYY-MM-DD string, returning a YYYY-MM-DD string (UTC). */
function addDaysUTC(dateStr, delta) {
  const d = parseDate(dateStr);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * Validate that two YYYY-MM-DD strings form a valid range (both parse, end >= start).
 * @param {string} start
 * @param {string} end
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateDateRange(start, end) {
  const ds = parseDate(start);
  if (!ds) return { valid: false, error: `START_DATE invalid: "${start}" (expected YYYY-MM-DD)` };
  const de = parseDate(end);
  if (!de) return { valid: false, error: `END_DATE invalid: "${end}" (expected YYYY-MM-DD)` };
  if (de < ds) return { valid: false, error: `END_DATE (${end}) is before START_DATE (${start})` };
  return { valid: true, error: null };
}

/**
 * Resolve env date config into a window descriptor.
 *
 * Rules:
 *   - neither set            → { mode:'rolling', recent: daysToFetch }
 *   - START only             → range START..today
 *   - END only               → range (END-365d)..END
 *   - both set               → range START..END
 *   - END in the future      → capped to today (recorded in `warnings`)
 *   - any malformed / end<start → { error } (caller logs + exits 1)
 *
 * Future-cap is applied to END *before* defaulting START, so an END-only future
 * date still yields a valid window (cap first, then derive the floor).
 *
 * @param {string} envStartDate
 * @param {string} envEndDate
 * @param {number} daysToFetch
 * @returns {{mode:'rolling',recent:number}
 *          |{mode:'range',startDate:string,endDate:string,warnings:string[]}
 *          |{error:string}}
 */
function resolveDateRange(envStartDate, envEndDate, daysToFetch) {
  const rawStart = String(envStartDate || '').trim();
  const rawEnd = String(envEndDate || '').trim();

  // No absolute config → preserve existing rolling-window behaviour.
  if (!rawStart && !rawEnd) {
    return { mode: 'rolling', recent: daysToFetch };
  }

  // Validate the FORMAT of any provided date before any defaulting/derivation.
  if (rawStart && !parseDate(rawStart)) {
    return { error: `START_DATE invalid: "${rawStart}" (expected YYYY-MM-DD)` };
  }
  if (rawEnd && !parseDate(rawEnd)) {
    return { error: `END_DATE invalid: "${rawEnd}" (expected YYYY-MM-DD)` };
  }

  const today = todayUTC();
  const warnings = [];

  // 1. Determine END (default today), then cap a future END to today.
  let end = rawEnd || today;
  if (parseDate(end) > parseDate(today)) {
    warnings.push(`END_DATE (${end}) is in the future — capped to today (${today})`);
    end = today;
  }

  // 2. Determine START (default 365 days before the resolved END).
  const start = rawStart || addDaysUTC(end, -365);

  // 3. Validate ordering.
  const v = validateDateRange(start, end);
  if (!v.valid) return { error: v.error };

  return { mode: 'range', startDate: start, endDate: end, warnings };
}

module.exports = { parseDate, addDaysUTC, validateDateRange, resolveDateRange, todayUTC };
