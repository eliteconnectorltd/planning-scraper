/**
 * planit.js
 *
 * Hardened Planit UK API acquisition layer.
 * Implements exponential backoff, detailed diagnostic logging, 
 * browser-mimicking headers, and a Playwright "nuclear option" fallback
 * to reliably retrieve the JSON application feeds despite network instability
 * or temporary bot blocking.
 */

const https = require('https');
const { URL } = require('url');
const { createHardenedPersistentContext } = require('./browserHardening');

// ── CONFIG ───────────────────────────────────────────────────────────────────
const PLANIT_BASE = 'https://www.planit.org.uk';
const PLANIT_TIMEOUT = parseInt(process.env.PLANIT_TIMEOUT, 10) || 60000;
const PLANIT_RETRIES = parseInt(process.env.PLANIT_RETRIES, 10) || 3;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── LOW-LEVEL ACQUISITION LOGIC ──────────────────────────────────────────────

/**
 * Makes a GET request to a URL and returns the parsed JSON body.
 * Includes browser-like headers and explicit timeout tracking.
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let dnsTime = 0;
    let tlsTime = 0;

    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-GB,en;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://www.planit.org.uk/',
          'Connection': 'keep-alive',
          'Cache-Control': 'max-age=0',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: PLANIT_TIMEOUT,
      },
      (res) => {
        // Follow redirects cleanly
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          return fetchJson(redirectUrl).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          res.resume(); // free up socket
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }

        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          const duration = Date.now() - startTime;
          try {
            const data = JSON.parse(raw);
            console.log(`[planit] [http] Fetch success (${duration}ms). TLS: ${tlsTime}ms. Size: ${raw.length}b.`);
            resolve(data);
          } catch (e) {
            const err = new Error(`JSON parse failed: ${e.message}`);
            err.code = 'JSON_PARSE_ERROR';
            reject(err);
          }
        });
      }
    );

    req.on('socket', (socket) => {
      socket.on('lookup', () => {
        dnsTime = Date.now() - startTime;
      });
      socket.on('secureConnect', () => {
        tlsTime = Date.now() - startTime - dnsTime;
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Socket Timeout (${PLANIT_TIMEOUT}ms)`));
    });

    req.on('error', (err) => {
      const duration = Date.now() - startTime;
      console.log(`[planit] [http] Request failed (${duration}ms): ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Playwright fallback mode. 
 * Invoked if HTTP requests fail, bypassing WAFs and complex blocks.
 */
async function fetchJsonWithPlaywrightFallback(url) {
  console.log(`[planit] [fallback] Initiating Playwright fallback mode for: ${url}`);
  const startTime = Date.now();
  let context = null;
  
  try {
    context = await createHardenedPersistentContext({ headless: true, sessionId: 'planit_fallback' });
    const page = await context.newPage();
    
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PLANIT_TIMEOUT });
    const rawText = await response.text();
    const duration = Date.now() - startTime;
    
    let json = null;
    try {
       json = JSON.parse(rawText);
       console.log(`[planit] [fallback] Playwright fallback successful (${duration}ms). Payload: ${rawText.length}b.`);
       return json;
    } catch (e) {
       // Check if the response contains HTML block pages
       const sample = rawText.substring(0, 100).replace(/\n/g, ' ');
       throw new Error(`Fallback returned invalid JSON (Block page?): ${sample}`);
    }
  } catch (err) {
    console.error(`[planit] [fallback] Playwright fallback explicitly failed: ${err.message}`);
    throw err;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

/**
 * Wraps raw HTTP acquisition with exponential backoff retries.
 * Routes to Playwright fallback on total failure.
 */
async function fetchJsonWithRetry(url) {
  let attempt = 1;
  const maxAttempts = PLANIT_RETRIES + 1;

  while (attempt <= maxAttempts) {
    try {
      if (attempt > 1) {
        console.log(`[planit] [retry] Attempt ${attempt}/${maxAttempts} for ${url}`);
      }
      return await fetchJson(url);
    } catch (err) {
      const isNetworkIssue = 
        err.message.includes('Timeout') || 
        err.message.includes('ECONNRESET') || 
        err.message.includes('ETIMEDOUT') || 
        err.message.includes('socket hang up') ||
        (err.statusCode && err.statusCode >= 500);

      const isBotBlock = err.statusCode === 403 || err.statusCode === 429;

      if (!isNetworkIssue && !isBotBlock) {
        console.log(`[planit] [error] Terminal/structural error encountered: ${err.message}`);
        break; // Don't retry 404s
      }

      if (attempt >= maxAttempts) {
        console.log(`[planit] [error] Exhausted ${PLANIT_RETRIES} retries for ${url}.`);
        break;
      }

      // If explicit bot block, increase backoff heavily to wait out rate limits
      const baseBackoff = isBotBlock ? 5000 : 1500;
      const backoffMs = Math.pow(2, attempt - 1) * baseBackoff;
      
      console.log(`[planit] [retry] Backing off for ${backoffMs}ms before next attempt (Error: ${err.message})`);
      await delay(backoffMs);
      attempt++;
    }
  }

  // Engage ultimate fallback
  return await fetchJsonWithPlaywrightFallback(url);
}


// ── CORE ORCHESTRATION ────────────────────────────────────────────────────────

/**
 * Returns a raw list of recent applications from the Planit list API.
 */
async function fetchApplicationList(days = 4, limit = 5, areaName = '') {
  const params = new URLSearchParams({
    recent: String(days),
    pg_sz: String(limit),
    max_recs: String(limit),
    sort: 'start_date.desc.nullslast,last_scraped.desc.nullslast',
    select: 'name,uid,altid,area_name,start_date,address,description,link',
  });

  if (areaName) {
    params.append('auth', areaName);  // Planit's council filter is 'auth', not 'area_name'
  }

  const url = `${PLANIT_BASE}/api/applics/json?${params.toString()}`;
  console.log(`[planit] Fetching list API: ${url}`);

  const json = await fetchJsonWithRetry(url);

  if (!json || !Array.isArray(json.records)) {
    throw new Error('[planit] List API did not return a records array');
  }

  console.log(`[planit] List API returned ${json.records.length} records (total available: ${json.total})`);
  return json.records;
}

// ── Planit detail metadata extraction ────────────────────────────────────────

/** Trim a value to a non-empty string, else null. */
function cleanStr(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** Parse a number cautiously; null on missing/empty/NaN. */
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/**
 * Sentinel filter for agent_name / applicant_name / case_officer.
 * Planit returns the literal string "See source" (any case) when it does NOT
 * actually hold the value — it's a "click through to the council portal"
 * placeholder, not real data. Treat it as null so we don't persist a sentinel.
 */
function filterSentinel(value) {
  const s = cleanStr(value);
  if (s === null) return null;
  return s.toLowerCase() === 'see source' ? null : s;
}

/**
 * URL filter for comment_url / map_url. Planit returns placeholder strings like
 * "See comment" / "See map" when it has no real URL — accept ONLY genuine http(s)
 * URLs, reject everything else (including those placeholders) to null.
 */
function urlOrNull(v) {
  const s = cleanStr(v);
  if (!s) return null;
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  return null;
}

/**
 * Builds the structured planitMetadata object from a detail JSON payload.
 * All fields are optional (null when absent/empty/NaN/sentinel). Dates are kept
 * RAW as strings — not reformatted (schema keeps date columns as text on purpose).
 *
 * @param {object} detail - Parsed Planit detail JSON
 * @returns {{ metadata: object, total: number, populated: number, redacted: number }}
 */
function buildPlanitMetadata(detail) {
  const of = (detail && detail.other_fields) || {}; // may be missing entirely

  // Raw cleaned sentinel candidates (pre-filter) so we can report redaction count.
  const rawAgent = cleanStr(of.agent_name);
  const rawApplicant = cleanStr(of.applicant_name);
  const rawCaseOfficer = cleanStr(of.case_officer);

  const agent_name = filterSentinel(of.agent_name);
  const applicant_name = filterSentinel(of.applicant_name);
  const case_officer = filterSentinel(of.case_officer);

  const metadata = {
    // From top-level
    description: cleanStr(detail.description),
    address: cleanStr(detail.address),
    postcode: cleanStr(detail.postcode),
    start_date: cleanStr(detail.start_date),
    app_size: cleanStr(detail.app_size),
    app_state: cleanStr(detail.app_state),
    app_type: cleanStr(detail.app_type),
    consulted_date: cleanStr(detail.consulted_date),
    decided_date: cleanStr(detail.decided_date),
    location_x: numOrNull(detail.location_x), // longitude
    location_y: numOrNull(detail.location_y), // latitude

    // From other_fields (safe access — any key may be absent)
    application_type: cleanStr(of.application_type),
    status: cleanStr(of.status),
    decided_by: cleanStr(of.decided_by),
    date_received: cleanStr(of.date_received),
    date_validated: cleanStr(of.date_validated),
    target_decision_date: cleanStr(of.target_decision_date),
    ward_name: cleanStr(of.ward_name),
    uprn: cleanStr(of.uprn),
    planning_portal_id: cleanStr(of.planning_portal_id),
    n_statutory_days: numOrNull(of.n_statutory_days),
    n_documents: numOrNull(of.n_documents), // Planit's own doc count, not a live count
    n_constraints: numOrNull(of.n_constraints),
    n_comments: numOrNull(of.n_comments),
    easting: numOrNull(of.easting),
    northing: numOrNull(of.northing),
    lat: numOrNull(of.lat),
    lng: numOrNull(of.lng),
    agent_company: cleanStr(of.agent_company),
    agent_address: cleanStr(of.agent_address),
    consultation_start_date: cleanStr(of.consultation_start_date), // raw, not reformatted
    comment_url: urlOrNull(of.comment_url),
    map_url: urlOrNull(of.map_url),

    // Sentinel-filtered (see filterSentinel)
    agent_name,
    applicant_name,
    case_officer,
  };

  let redacted = 0;
  if (rawAgent && agent_name === null) redacted++;
  if (rawApplicant && applicant_name === null) redacted++;
  if (rawCaseOfficer && case_officer === null) redacted++;

  const total = Object.keys(metadata).length;
  const populated = Object.values(metadata).filter(v => v !== null && v !== undefined).length;

  return { metadata, total, populated, redacted };
}

/**
 * Fetches the full detail JSON for a single application to extract source URLs
 * and the broader planning metadata Planit exposes.
 */
async function fetchApplicationDetail(planitPageUrl) {
  const detailUrl = planitPageUrl.endsWith('/')
    ? `${planitPageUrl}json`
    : `${planitPageUrl}/json`;

  console.log(`[planit] Fetching detail API: ${detailUrl}`);

  try {
    const detail = await fetchJsonWithRetry(detailUrl);
    const { metadata, total, populated, redacted } = buildPlanitMetadata(detail);
    // Counts only — never log values (case_officer etc. may be sensitive).
    console.log(`[planit] Metadata: ${populated}/${total} fields populated (${redacted} redacted)`);
    return {
      sourceUrl: detail.url || null,
      docsUrl: detail.other_fields?.docs_url || null,
      nDocuments: detail.other_fields?.n_documents ?? null,
      scraperName: detail.scraper_name || detail.area_name || null,
      otherFields: detail.other_fields || {},
      planitMetadata: metadata,
    };
  } catch (err) {
    console.log(`[planit] Detail API completely failed for ${planitPageUrl}: ${err.message}`);
    return {
      sourceUrl: null,
      docsUrl: null,
      nDocuments: null,
      scraperName: null,
      otherFields: {},
      planitMetadata: null,
    };
  }
}

/**
 * Fetches recent planning applications from Planit and enriches each with
 * the council portal URL and docs URL from the detail API.
 */
async function getApplications(pageOrDays, locationOrLimit, optionalAreaName) {
  let days = 4;
  let limit = 5;
  let areaName = '';

  if (pageOrDays && typeof pageOrDays === 'object' && pageOrDays.goto) {
    areaName = locationOrLimit || '';
  } else {
    days = typeof pageOrDays === 'number' ? pageOrDays : 4;
    limit = typeof locationOrLimit === 'number' ? locationOrLimit : 5;
    areaName = optionalAreaName || '';
  }

  console.log(`\n[planit] === Fetching up to ${limit} applications (last ${days} days, area: ${areaName || 'all'}) ===`);

  const listRecords = await fetchApplicationList(days, limit, areaName);
  const applications = [];

  for (const record of listRecords) {
    console.log(`\n[planit] Processing: ${record.name}`);
    console.log(`[planit]   Area: ${record.area_name}`);
    console.log(`[planit]   Address: ${record.address}`);

    const planitUrl = record.link;
    const detail = await fetchApplicationDetail(planitUrl);

    console.log(`[planit]   Source URL:  ${detail.sourceUrl || 'NOT FOUND'}`);
    console.log(`[planit]   Docs URL:    ${detail.docsUrl || 'NOT FOUND'}`);
    console.log(`[planit]   N Documents: ${detail.nDocuments ?? 'unknown'}`);

    applications.push({
      title: record.uid || record.name,
      area: record.area_name,
      address: record.address || '',
      description: record.description || '',
      startDate: record.start_date || '',
      planitUrl,
      sourceUrl: detail.sourceUrl,
      docsUrl: detail.docsUrl,
      nDocuments: detail.nDocuments,
      // Broader Planit detail metadata (platform-agnostic, available to all
      // consumers). null if the detail fetch failed for this application.
      planitMetadata: detail.planitMetadata || null,
    });

    // Small delay between successful acquisitions to avoid triggering rate limits
    await delay(750);
  }

  console.log(`\n[planit] Done — ${applications.length} applications enriched`);
  return applications;
}

module.exports = { getApplications };
