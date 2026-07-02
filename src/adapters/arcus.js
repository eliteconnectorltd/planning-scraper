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
 * Map contact/decision fields from the Arcus application metadata payload
 * (GET /api/application/{id} — documented in the header comment, previously unused).
 *
 * Key names VERIFIED against a live Islington payload (flat object, no nesting):
 * applicant/agent names split into Forename/Surname (+ an oft-null Name field);
 * officerName, decisionText, statutoryExpiryDate. agent_company/agent_address are
 * not returned by this endpoint (kept null). Absent fields stay null — adapterContacts
 * skips nulls, so nothing is clobbered.
 */
function mapArcusMetadata(meta) {
  if (!meta || typeof meta !== 'object') return null;

  // Compose a full name from forename + surname when both meaningful.
  // Arcus often puts the whole entity name in the surname field
  // (organizations, "C/O Agent" placeholders, etc.), so surname alone
  // is usually the right answer.
  const composeName = (forename, surname, nameField) => {
    // Prefer explicit name field if populated
    if (nameField && String(nameField).trim()) return String(nameField).trim();
    const f = (forename || '').trim();
    const s = (surname || '').trim();
    if (!f && !s) return null;
    // Avoid duplication: if surname already contains forename, use surname alone
    if (f && s && !s.toLowerCase().startsWith(f.toLowerCase())) return `${f} ${s}`;
    return s || f;
  };

  return {
    applicant_name: composeName(meta.applicantForename, meta.applicantSurname, meta.applicantName),
    agent_name: composeName(meta.agentForename, meta.agentSurname, meta.agentName),
    agent_company: null,  // Arcus does not separate agent company from name
    agent_address: null,  // Not returned by this endpoint
    case_officer: meta.officerName || null,
    decision: meta.decisionText || null,
    target_decision_date: meta.statutoryExpiryDate || null,
    consultation_start_date: meta.pressNoticeStartDate
      || meta.siteNoticeDate
      || null,
  };
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

  // Application metadata (contact/decision fields). Documented endpoint, separate
  // from the document list. Best-effort — a failure here never fails the scrape.
  let metadata = null;
  try {
    const mres = await request.get(`${API_BASE}/api/application/${ctx.id}`, { headers, timeout: 30000 });
    if (mres.ok()) {
      metadata = mapArcusMetadata(await mres.json());
      const found = metadata ? Object.entries(metadata).filter(([, v]) => v).map(([k]) => k) : [];
      console.log(`[arcus] ${ctx.council} app ${ctx.id}: metadata fields: ${found.length ? found.join(', ') : 'none (verify key names against a live payload)'}`);
    } else {
      console.log(`[arcus] ${ctx.council} app ${ctx.id}: metadata HTTP ${mres.status()} — contact fields skipped`);
    }
  } catch (err) {
    console.log(`[arcus] ${ctx.council} app ${ctx.id}: metadata fetch error: ${err.message}`);
  }

  metrics.totalRows = list.length;
  metrics.validDocs = documents.length;
  metrics.runtimeMs = Date.now() - startTime;
  metrics.success = documents.length > 0;

  console.log(`[arcus] ${ctx.council} app ${ctx.id}: ${documents.length} document(s) in ${metrics.runtimeMs}ms`);
  // The Arcus document download endpoint requires the same per-council API
  // headers as the listing call. Declare them so downloadManager can apply them
  // (without these, file fetches return HTTP 401). Headers only — no cookies.
  return {
    documents,
    metrics,
    metadata: metadata || undefined,
    downloadAuth: { headers: arcusHeaders(ctx.council) },
  };
}

module.exports = {
  scrapeArcusDocuments,
  parseArcusUrl,
  clientCode,
  CLIENT_CODES,
  mapArcusMetadata,
};
