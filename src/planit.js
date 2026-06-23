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

/**
 * Fetches the full detail JSON for a single application to extract source URLs.
 */
async function fetchApplicationDetail(planitPageUrl) {
  const detailUrl = planitPageUrl.endsWith('/')
    ? `${planitPageUrl}json`
    : `${planitPageUrl}/json`;

  console.log(`[planit] Fetching detail API: ${detailUrl}`);

  try {
    const detail = await fetchJsonWithRetry(detailUrl);
    return {
      sourceUrl: detail.url || null,
      docsUrl: detail.other_fields?.docs_url || null,
      nDocuments: detail.other_fields?.n_documents ?? null,
      scraperName: detail.scraper_name || detail.area_name || null,
      otherFields: detail.other_fields || {},
    };
  } catch (err) {
    console.log(`[planit] Detail API completely failed for ${planitPageUrl}: ${err.message}`);
    return {
      sourceUrl: null,
      docsUrl: null,
      nDocuments: null,
      scraperName: null,
      otherFields: {},
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
    });

    // Small delay between successful acquisitions to avoid triggering rate limits
    await delay(750);
  }

  console.log(`\n[planit] Done — ${applications.length} applications enriched`);
  return applications;
}

module.exports = { getApplications };
