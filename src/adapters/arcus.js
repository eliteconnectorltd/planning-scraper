/**
 * adapters/arcus.js
 *
 * Adapter for Agile Applications "Citizen Portal" councils
 * (planning.agileapplications.co.uk/{council}/application-details/{id}).
 *
 * Unlike Idox, Arcus exposes a clean JSON API, so this adapter does NOT scrape
 * the Playwright page DOM. It calls the API via the page's request context
 * (so it shares cookies/session and the project's browser hardening) and returns
 * the SAME shape as scrapeIdoxDocuments: { documents, metrics }.
 *
 * Verified endpoints (live):
 *   GET {api}/api/application/{id}            -> application metadata
 *   GET {api}/api/application/{id}/document   -> document list
 *   GET {api}/api/application/document/{hash} -> file download
 *   Required headers: x-client (per-council code), x-product=CITIZENPORTAL, x-service=PA
 */

const API_BASE = 'https://planningapi.agileapplications.co.uk';
const PORTAL_BASE = 'https://planning.agileapplications.co.uk';

// Per-council API client codes. The URL slug is NOT always the code:
//   islington -> "IS" (not "ISLINGTON"). Verify each new council from a live
//   /api/application/... request's x-client request header.
const CLIENT_CODES = {
  cannock: 'CANNOCK',
  islington: 'IS',
  middlesbrough: 'MIDDLESBROUGH',
  slough: 'SLOUGH',
};

function clientCode(council) {
  const key = (council || '').toLowerCase();
  return CLIENT_CODES[key] || key.toUpperCase();
}

/** Parse { council, id } from an Arcus URL. */
function parseArcusUrl(input) {
  try {
    const u = new URL(input);
    if (!/agileapplications\.co\.uk$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/([^/]+)\/application-?details\/(\d+)/i);
    if (!m) return null;
    return { council: m[1].toLowerCase(), id: m[2] };
  } catch {
    return null;
  }
}

function arcusHeaders(council) {
  return {
    'x-client': clientCode(council),
    'x-product': 'CITIZENPORTAL',
    'x-service': 'PA',
  };
}

function documentDownloadUrl(hash) {
  return `${API_BASE}/api/application/document/${hash}`;
}

/**
 * Main adapter. Signature matches scrapeIdoxDocuments(page, url).
 * Uses page.context().request for HTTP so it shares the hardened browser session.
 */
async function scrapeArcusDocuments(page, url) {
  const startTime = Date.now();
  const ctx = parseArcusUrl(url);
  const metrics = { totalRows: 0, validDocs: 0, runtimeMs: 0, success: false };

  if (!ctx) {
    metrics.runtimeMs = Date.now() - startTime;
    console.log(`[arcus] Could not parse Arcus URL: ${url}`);
    return { documents: [], metrics };
  }

  const request = page.context().request;
  const headers = { ...arcusHeaders(ctx.council), Accept: 'application/json' };

  let list = [];
  try {
    const res = await request.get(
      `${API_BASE}/api/application/${ctx.id}/document`,
      { headers, timeout: 30000 }
    );
    if (!res.ok()) {
      if (res.status() === 401) {
        const e = new Error(`Arcus 401 — x-client "${clientCode(ctx.council)}" invalid for ${ctx.council}`);
        e.code = 'BLOCKED';
        throw e;
      }
      throw new Error(`Arcus document list HTTP ${res.status()}`);
    }
    const json = await res.json();
    list = Array.isArray(json) ? json : [];
  } catch (err) {
    metrics.runtimeMs = Date.now() - startTime;
    if (err.code === 'BLOCKED') throw err;
    console.log(`[arcus] Document list error: ${err.message}`);
    return { documents: [], metrics };
  }

  const documents = list
    .filter((d) => d.documentHash)
    .map((d) => ({
      name: d.name || 'Document',
      type: d.mediaDescription || 'Document',
      date: d.receivedDate || null,
      url: documentDownloadUrl(d.documentHash),
      confidence: 'HIGH', // direct token download
    }));

  metrics.totalRows = list.length;
  metrics.validDocs = documents.length;
  metrics.runtimeMs = Date.now() - startTime;
  metrics.success = documents.length > 0;

  console.log(`[arcus] ${ctx.council} app ${ctx.id}: ${documents.length} document(s) in ${metrics.runtimeMs}ms`);
  return { documents, metrics };
}

module.exports = {
  scrapeArcusDocuments,
  parseArcusUrl,
  clientCode,
  CLIENT_CODES,
};
