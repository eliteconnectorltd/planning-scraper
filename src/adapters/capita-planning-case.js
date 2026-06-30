/**
 * adapters/capita-planning-case.js
 *
 * Adapter for the **Capita "Planning Case" documents subsystem** that sits behind
 * many Northgate Planning-Explorer councils (e.g. Wandsworth). The Northgate
 * `planning.{council}` host is the search/detail front-end; the documents live on
 * a separate `planning2.{council}/planningcase/` + `/IAM/` Capita store.
 *
 * This is the project's FIRST no-Playwright adapter — pure HTTP (Node 18+ global
 * `fetch`) with a tiny manual cookie jar for the ASP.NET WebForms GET→postback
 * sequence. It DISCOVERS document links and returns them; the orchestrator runs
 * the shared downloadManager loop (extraction_method='capita-planning-case',
 * context=null). It never downloads files itself.
 *
 * detectPlatform() still returns 'northgate' (truthful platform); routeAdapter()
 * returns 'capita' when the URL carries `planningcase/comments.aspx`.
 *
 * HONEST SCOPE (see docs/capita-planning-case.md):
 *   - Contact fields (applicant/agent/case_officer) are NOT on the comments page
 *     (they live on the Northgate detail page, a different host) → returned null.
 *   - Older / pre-Capita applications → clean `requires_different_path`, not a crash.
 *   - The gvDocs/gvResults/__doPostBack parsing is regex-based and verified against
 *     the Wandsworth capture; control-id assumptions are flagged inline and must be
 *     re-checked when onboarding a new council (no per-council code lives here).
 *
 * NO council-specific code by design. If a council needs bespoke handling, that's
 * a signal for its own adapter.
 */

'use strict';

const DEFAULT_TIMEOUT_MS = Number(process.env.CAPITA_TIMEOUT_MS) || 30000;
const MAX_POSTBACKS = Number(process.env.CAPITA_MAX_POSTBACKS) || 25; // safety bound
// Download URL strategy — see docs/capita-planning-case.md §URL strategy.
//   'iamlink'  -> /IAM/IAMLink.aspx?docid={id}   (type-agnostic redirector; PREFERRED
//                 iff verified stateless+correct content-type in Phase 3c testing)
//   'iamcache' -> /iam/IAMCache/{id}/{id}.pdf    (direct file; PDF-only caveat)
const DOC_URL_STRATEGY = (process.env.CAPITA_DOC_URL_STRATEGY || 'iamlink').toLowerCase();

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// Anti-bot markers (detect-and-record ONLY — never bypass; same policy as generic).
const ANTI_BOT_MARKERS = [
  'just a moment...', 'cloudflare', 'verify you are human', 'access denied',
  'bot detection', 'captcha required',
];

// ── tiny cookie jar ─────────────────────────────────────────────────────────
// ASP.NET hands out an ASP.NET_SessionId on the first GET that the postbacks must
// echo back. We only need name=value; path/expiry are irrelevant for one sequence.
function makeJar() {
  const store = new Map();
  return {
    absorb(response) {
      // Node 18+/undici exposes getSetCookie(); fall back to the combined header.
      let cookies = [];
      if (typeof response.headers.getSetCookie === 'function') {
        cookies = response.headers.getSetCookie();
      } else {
        const raw = response.headers.get('set-cookie');
        if (raw) cookies = [raw];
      }
      for (const c of cookies) {
        const pair = String(c).split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      if (store.size === 0) return undefined;
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

// ── HTTP helpers (with timeout) ─────────────────────────────────────────────
async function httpRequest(method, url, { jar, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const headers = { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml' };
    const cookie = jar && jar.header();
    if (cookie) headers['Cookie'] = cookie;
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const resp = await fetch(url, { method, headers, body, redirect: 'follow', signal: controller.signal });
    if (jar) jar.absorb(resp);
    const text = await resp.text();
    return { status: resp.status, url: resp.url || url, body: text };
  } finally {
    clearTimeout(timer);
  }
}
const httpGet = (url, jar) => httpRequest('GET', url, { jar });
const httpPost = (url, jar, body) => httpRequest('POST', url, { jar, body });

// ── parsing helpers (regex; no cheerio dependency) ──────────────────────────

// Decode the HTML entities that actually appear in this portal's markup — the
// common named set plus numeric decimal (&#NN;) and hex (&#xNN;). No external
// dependency (he/html-entities are not installed). Applied to any text/attribute
// extracted from the HTML BEFORE further matching/regex.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", // belt-and-braces; numeric path below also covers it
};
function decodeEntities(s) {
  if (s == null) return '';
  return String(s)
    // numeric hex: &#x27; / &#X27;
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    })
    // numeric decimal: &#39; (with optional leading zeros)
    .replace(/&#(\d+);/g, (_, d) => {
      const n = parseInt(d, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    })
    // named: &amp; &lt; &gt; &quot; &apos; &nbsp;
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v !== undefined ? v : m;
    });
}

function stripTags(s) {
  return decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Value of an ASP.NET hidden field by exact name (handles value before/after name). */
function hiddenField(html, name) {
  const esc = name.replace(/[$]/g, '\\$');
  const a = html.match(new RegExp(`<input[^>]*name="${esc}"[^>]*value="([^"]*)"`, 'i'));
  if (a) return a[1];
  const b = html.match(new RegExp(`<input[^>]*value="([^"]*)"[^>]*name="${esc}"`, 'i'));
  return b ? b[1] : '';
}

/** Text of a <span>/element whose id ENDS in `suffix` (ASP.NET prefixes ctl00_…). */
function labelText(html, suffix) {
  const m = html.match(new RegExp(`id="[^"]*${suffix}"[^>]*>([\\s\\S]*?)</span>`, 'i'));
  return m ? (stripTags(m[1]) || null) : null;
}

function parseCaseParam(url) {
  const m = String(url || '').match(/[?&]case=([^&]+)/i);
  try { return m ? decodeURIComponent(m[1]) : null; } catch { return m ? m[1] : null; }
}

/**
 * Ref from the Planit title. Strips exactly one leading authority segment.
 *   "Wandsworth/2024/4485"     -> "2024/4485"
 *   "Wandsworth/2024/4485/FUL" -> "2024/4485/FUL"
 *   "2024/4485"                -> "2024/4485"
 *   ""/null                    -> null
 */
function extractCaseRef(application) {
  const raw = (application && (application.title || application.application_uid)) || '';
  const m = String(raw).match(/^[A-Za-z][\w .'-]*\/(.+)$/);
  const ref = (m ? m[1] : String(raw)).trim();
  return ref || null;
}

function detectAntiBot(html) {
  const sample = String(html || '').slice(0, 4000).toLowerCase();
  return ANTI_BOT_MARKERS.find(m => sample.includes(m)) || null;
}

/**
 * Collect document ids from the currently-rendered gvResults table.
 * Matches both IAMLink.aspx?docid= and IAMCache/{id}/ forms so it works whichever
 * link form the page emits. Returns [{ docid, name }].
 */
function parseDocIds(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]*href="([^"]*(?:IAMLink\.aspx\?docid=(\d+)|IAMCache\/(\d+)\/)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const docid = m[2] || m[3];
    if (!docid || seen.has(docid)) continue;
    seen.add(docid);
    out.push({ docid, name: stripTags(m[4]) || `Document ${docid}` });
  }
  return out;
}

/**
 * Collect category postback targets from the gvDocs table — the per-category
 * "show" links rendered as javascript:__doPostBack('TARGET','').
 *
 * CONTROL-ID ASSUMPTION (verify per the Wandsworth capture): document-category
 * show links carry a target containing 'gvDocs' (the GridView id). We restrict to
 * those to avoid firing pagination/sort postbacks. Returns unique target strings.
 */
function parseCategoryTargets(html) {
  const out = [];
  const seen = new Set();
  // Real Wandsworth HTML entity-encodes the quotes inside the href:
  //   href="javascript:__doPostBack(&#39;gvDocs$ctl02$lnkDShow&#39;,&#39;&#39;)"
  // Fully decode HTML entities (named + numeric decimal + hex) to literal chars
  // before matching, so both raw and entity-encoded forms parse identically.
  const decoded = decodeEntities(html);
  const re = /__doPostBack\('([^']*gvDocs[^']*)'\s*,\s*'[^']*'\)/gi;
  let m;
  while ((m = re.exec(decoded)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

/**
 * Row-aware parser for the gvResults table (verified against the live Wandsworth
 * capture — see docs/era-testing-results.md / capita-planning-case.md). Each data
 * row is three columns:
 *   <td><span id="gvResults_Label1_N">30 Jan 2024</span></td>   -> date
 *   <td><span id="gvResults_Label2_N">Site Plan</span></td>     -> description (may be empty)
 *   <td><a href="...IAMLink.aspx?docid=5854005">View document</a></td> -> docid
 * Returns [{ docid, date, description }]. Header row (no docid) is skipped; an empty
 * description becomes null (not ''); deduped by docid. Scoped to the gvResults table
 * when present so a stray IAM link elsewhere can't leak in.
 */
function parseDocRows(html) {
  const scope = (String(html || '').match(/id="gvResults"[\s\S]*?<\/table>/i) || [String(html || '')])[0];
  const out = [];
  const seen = new Set();
  const rowRe = /<tr\b[\s\S]*?<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(scope)) !== null) {
    const row = rm[0];
    const docm = row.match(/(?:IAMLink\.aspx\?docid=(\d+)|IAMCache\/(\d+)\/)/i);
    if (!docm) continue; // header / non-document row
    const docid = docm[1] || docm[2];
    if (seen.has(docid)) continue;
    seen.add(docid);
    const d1 = row.match(/id="[^"]*Label1[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const d2 = row.match(/id="[^"]*Label2[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    out.push({
      docid,
      date: d1 ? (stripTags(d1[1]) || null) : null,
      description: d2 ? (stripTags(d2[1]) || null) : null,
    });
  }
  return out;
}

/**
 * Parse the gvDocs category table into [{ target, label, count }]. The category
 * NAME lives in gvDocs_lblChoice_{i}; the per-category COUNT in gvDocs_Label2_{i}
 * (NOT a description — that's a different table). Postback targets come from
 * parseCategoryTargets() in document order and are zipped by index with the labels
 * (gvDocs row i ↔ target i). No control-id-numbering assumption.
 */
function parseCategoryRows(html) {
  const labels = [...String(html || '').matchAll(/id="[^"]*lblChoice[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)]
    .map(m => stripTags(m[1]) || null);
  const counts = [...String(html || '').matchAll(/id="[^"]*gvDocs_Label2_\d+"[^>]*>([\s\S]*?)<\/span>/gi)]
    .map(m => { const n = parseInt(stripTags(m[1]), 10); return Number.isFinite(n) ? n : null; });
  const targets = parseCategoryTargets(html);
  const n = Math.max(labels.length, targets.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ target: targets[i] || null, label: labels[i] || null, count: counts[i] ?? null });
  }
  return rows;
}

/** The category currently shown, from "Showing one document of type: X." (lblDocType). */
function parseShownDocType(html) {
  const m = String(html || '').match(/id="[^"]*lblDocType[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  if (!m) return null;
  const txt = stripTags(m[1]);
  const t = txt.match(/type:\s*(.+?)\.?$/i);
  return t ? (t[1].trim() || null) : null;
}

function buildDocUrl(host, docid) {
  if (DOC_URL_STRATEGY === 'iamcache') {
    return `https://${host}/iam/IAMCache/${docid}/${docid}.pdf`;
  }
  return `https://${host}/IAM/IAMLink.aspx?docid=${docid}`;
}

// ── main ─────────────────────────────────────────────────────────────────────
/**
 * @param {object} application Planit app object (title → ref).
 * @param {string} navUrl      resolved nav target from the orchestrator.
 * @returns {Promise<{documents, metrics, metadata, downloadAuth, scrapeStatusHint}>}
 */
async function scrapeCapitaDocuments(application, navUrl) {
  const startedAt = Date.now();
  const council = (application && (application.area || application.council)) || 'Unknown';
  const refFromTitle = extractCaseRef(application);

  const result = {
    documents: [],
    metrics: { totalRows: 0, validDocs: 0, runtimeMs: 0, success: false, partial: false },
    metadata: {
      address: null, case_no: null, status: null, dev_description: null,
      applicant_name: null, agent_name: null, case_officer: null,
    },
    downloadAuth: undefined, // public stateless files
    scrapeStatusHint: null,
  };
  const finish = (hint) => {
    if (hint) result.scrapeStatusHint = hint;
    result.metrics.runtimeMs = Date.now() - startedAt;
    return result;
  };

  if (!navUrl) {
    console.log(`[capita] ${council}: no nav URL — requires_different_path`);
    return finish('requires_different_path');
  }

  const jar = makeJar();

  // ── Step 0: resolve the comments URL ────────────────────────────────────────
  let commentsUrl;
  let ref;
  try {
    if (/planningcase\/comments\.aspx/i.test(navUrl)) {
      commentsUrl = navUrl;
      ref = parseCaseParam(navUrl) || refFromTitle;
    } else {
      // navUrl is a Northgate detail page — find the footer comments anchor.
      const detail = await httpGet(navUrl, jar);
      const bot0 = detectAntiBot(detail.body);
      if (bot0) { console.log(`[capita] ${council}: anti-bot marker '${bot0}' on detail page — skipping`); return finish('blocked_anti_bot'); }
      const m = detail.body.match(/href="([^"]*planningcase\/comments\.aspx\?case=[^"]*)"/i);
      if (!m) {
        console.log(`[capita] ${council} ${refFromTitle || '?'}: no Capita comments link on detail page — requires_different_path (flag for adapter)`);
        return finish('requires_different_path');
      }
      commentsUrl = new URL(m[1].replace(/&amp;/gi, '&'), detail.url || navUrl).href;
      ref = parseCaseParam(commentsUrl) || refFromTitle;
    }
  } catch (err) {
    return finish(/abort|timeout/i.test(String(err && err.message)) ? 'timeout' : 'portal_unreachable');
  }

  const host = (() => { try { return new URL(commentsUrl).host; } catch { return ''; } })();
  if (!host) { console.log(`[capita] ${council}: malformed comments URL — requires_different_path`); return finish('requires_different_path'); }

  // ── Step 1: GET comments.aspx, parse initial state ──────────────────────────
  let html;
  try {
    const resp = await httpGet(commentsUrl, jar);
    if (resp.status >= 400) {
      console.log(`[capita] ${council} ${ref || '?'}: comments.aspx HTTP ${resp.status} — portal_unreachable`);
      return finish('portal_unreachable');
    }
    html = resp.body;
  } catch (err) {
    return finish(/abort|timeout/i.test(String(err && err.message)) ? 'timeout' : 'portal_unreachable');
  }

  const bot = detectAntiBot(html);
  if (bot) { console.log(`[capita] ${council}: anti-bot marker '${bot}' — skipping`); return finish('blocked_anti_bot'); }

  result.metadata.address = labelText(html, 'lblAddress');
  result.metadata.case_no = labelText(html, 'lblCaseNo');
  result.metadata.status = labelText(html, 'lblStatus');
  result.metadata.dev_description = labelText(html, 'lblDevDesc');

  let viewstate = hiddenField(html, '__VIEWSTATE');
  let viewstategen = hiddenField(html, '__VIEWSTATEGENERATOR');
  let eventvalidation = hiddenField(html, '__EVENTVALIDATION');

  // docid -> { docid, date, description, type }. Category context (type) is the
  // gvDocs label of whichever postback rendered the row.
  const docMap = new Map();
  const categories = parseCategoryRows(html);
  const totalExpected = categories.reduce((s, c) => s + (c.count || 0), 0);

  // Any docs rendered on the initial load (usually none for Wandsworth — gvResults
  // is empty until a postback) are tagged with the type lblDocType reports, falling
  // back to the first category.
  const initialType = parseShownDocType(html) || (categories[0] && categories[0].label) || null;
  for (const d of parseDocRows(html)) {
    if (!docMap.has(d.docid)) docMap.set(d.docid, { ...d, type: initialType });
  }

  // ── Step 2: __doPostBack per category, tagging docs with the category label ──
  const postbackCats = categories.filter(c => c.target).slice(0, MAX_POSTBACKS);
  for (const cat of postbackCats) {
    if (!viewstate) { result.metrics.partial = true; break; } // can't postback without state
    const body = new URLSearchParams({
      __EVENTTARGET: cat.target,
      __EVENTARGUMENT: '',
      __VIEWSTATE: viewstate,
      __VIEWSTATEGENERATOR: viewstategen,
      __EVENTVALIDATION: eventvalidation,
    }).toString();
    try {
      const resp = await httpPost(commentsUrl, jar, body);
      if (resp.status >= 400 || !resp.body) {
        result.metrics.partial = true;
        console.log(`[capita] ${council} ${ref || '?'}: category postback HTTP ${resp.status} — returning partial`);
        continue;
      }
      // Thread the FRESH hidden fields forward (sequential, browser-like).
      const vs = hiddenField(resp.body, '__VIEWSTATE');
      if (vs) viewstate = vs;
      const vg = hiddenField(resp.body, '__VIEWSTATEGENERATOR'); if (vg) viewstategen = vg;
      const ev = hiddenField(resp.body, '__EVENTVALIDATION'); if (ev) eventvalidation = ev;
      // Prefer the category label this postback was for; fall back to whatever
      // lblDocType in the response reports.
      const shownType = cat.label || parseShownDocType(resp.body);
      for (const d of parseDocRows(resp.body)) {
        if (!docMap.has(d.docid)) docMap.set(d.docid, { ...d, type: shownType });
      }
    } catch (err) {
      result.metrics.partial = true;
      console.log(`[capita] ${council} ${ref || '?'}: category postback error (${String(err && err.message).split('\n')[0]}) — returning partial`);
      continue; // keep what we have; do NOT fail the whole application
    }
  }

  // ── Step 3: build document records ──────────────────────────────────────────
  for (const d of docMap.values()) {
    // name: prefer the human description; else "<Type> <docid>" so two docs in the
    // same application never collide (e.g. "Application Form 5854005").
    const name = d.description || `${d.type || 'Document'} ${d.docid}`;
    result.documents.push({
      name,
      description: d.description || null,
      type: d.type || null,
      date: d.date || null,
      url: buildDocUrl(host, d.docid),
      confidence: 'HIGH',
    });
  }
  result.metrics.totalRows = totalExpected || docMap.size;
  result.metrics.validDocs = result.documents.length;
  const reachedAndParsed = Boolean(
    result.metadata.address || result.metadata.case_no ||
    result.metadata.status || result.metadata.dev_description
  );
  result.metrics.success = result.documents.length > 0 || reachedAndParsed;

  if (result.documents.length === 0) {
    // Page reached and parsed, but no documents in the table.
    result.scrapeStatusHint = 'no_documents';
  }

  console.log(`[capita] ${council} ${ref || '?'}: docs=${result.documents.length}/${totalExpected} categories=${postbackCats.length} partial=${result.metrics.partial} strategy=${DOC_URL_STRATEGY}`);
  return finish();
}

module.exports = {
  scrapeCapitaDocuments,
  // exported for unit tests:
  decodeEntities,
  extractCaseRef,
  parseCaseParam,
  parseDocIds,      // legacy (anchor-text only) — retained for compatibility
  parseDocRows,     // row-aware: { docid, date, description }
  parseCategoryRows,// gvDocs: { target, label, count }
  parseShownDocType,
  parseCategoryTargets,
  hiddenField,
  labelText,
  buildDocUrl,
};
