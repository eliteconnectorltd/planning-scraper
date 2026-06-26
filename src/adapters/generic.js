/**
 * adapters/generic.js
 *
 * Platform-agnostic Playwright harvester for council portals NOT covered by the
 * Idox/Arcus/Salesforce adapters (i.e. detector → northgate/socrata/unknown).
 *
 * Returns the SAME convention as the other adapters: it DISCOVERS document links
 * and DOES NOT download them — the orchestrator (src/index.js) runs the shared
 * downloadManager loop. It also extracts contact fields (applicant/agent/
 * case_officer) by label and surfaces a scrapeStatusHint for terminal conditions
 * (anti-bot / login / timeout / unreachable) detected during navigation.
 *
 * HONEST SCOPE — this will NOT achieve full coverage. It cannot handle:
 *   - extension-less tokenized document handlers (e.g. getDocument?id=...)
 *   - JS-only document lists that never expose <a href> in the DOM
 *   - embedded PDF viewers with no direct link
 *   - paginated document lists (only the first page is read)
 *   - anti-bot / login walls (detected and recorded, NEVER bypassed)
 * These surface as honest per-application status, not crashes.
 *
 * NO council-specific code lives here by design. If a council needs bespoke
 * handling, that's a signal it needs its own adapter — we log it and move on.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = Number(process.env.GENERIC_TIMEOUT_MS) || 30000;
const DEBUG_DIR = path.join(__dirname, '..', '..', 'output', 'debug');
const MAX_DEBUG_FILES = 100;

// Document link = <a href> whose path ends in one of these (case-insensitive),
// allowing a trailing query/fragment.
const FILE_EXT_RE = /\.(pdf|docx?|tiff?|jpe?g|png|zip|dwg|xlsx?)(?:$|[?#])/i;

// Field label variants (lowercased). First variant that resolves wins.
const FIELD_LABELS = {
  applicant_name: ['applicant name', 'applicant', 'applicant details', 'applicants name'],
  agent_name: ['agent name', 'agent', 'agent details', 'agents name'],
  case_officer: ['case officer', 'case officer name', 'officer', 'planning officer', 'application officer'],
};

// Post-trim, case-insensitive placeholder values → treated as null (no data).
const PLACEHOLDERS = new Set([
  'private', 'private individual', 'redacted', 'n/a', 'na', '-', 'not available',
  'see source', 'personal data removed', 'information not available',
]);

// Anti-bot / challenge markers (detect-and-record ONLY — never bypass).
const ANTI_BOT_MARKERS = [
  'just a moment...', 'cloudflare', 'verify you are human', 'access denied',
  'bot detection', 'captcha required',
];
// Strong login-wall markers (weak ones like "sign in" appear in normal nav, so
// they're excluded to avoid false positives; a password field is also a signal).
const LOGIN_MARKERS = ['login required', 'please log in', 'you must log in', 'authentication required'];

const DOC_TAB_TEXTS = [
  'view documents', 'all documents', 'application documents', 'associated documents',
  'supporting documents', 'public documents', 'documents', 'plans', 'drawings', 'files',
];

// ── helpers ───────────────────────────────────────────────────────────────────

function cleanField(value) {
  if (!value) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return PLACEHOLDERS.has(s.toLowerCase()) ? null : s;
}

/** Detect anti-bot challenge or login wall. Returns {blocked|login, marker} or {}. */
async function detectGate(page) {
  const title = (await page.title().catch(() => '')) || '';
  const body = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  const sample = `${title}\n${String(body).slice(0, 4000)}`.toLowerCase();
  for (const m of ANTI_BOT_MARKERS) if (sample.includes(m)) return { blocked: true, marker: m };
  for (const m of LOGIN_MARKERS) if (sample.includes(m)) return { login: true, marker: m };
  const hasPassword = await page.locator('input[type="password"]').count()
    .then(c => c > 0).catch(() => false);
  if (hasPassword) return { login: true, marker: 'password field' };
  return {};
}

/** Label-based contact-field extraction. Tries 6 DOM patterns in order. */
async function extractFields(page) {
  return page.evaluate((labelMap) => {
    const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const textOf = el => norm(el && (el.innerText || el.textContent));
    const clean = el => textOf(el).toLowerCase().replace(/:\s*$/, '').trim();

    function valueForLabel(label) {
      const lt = label.toLowerCase();
      // 1 & 3: <th>/<td> label, value in the next cell
      for (const c of document.querySelectorAll('th, td')) {
        if (clean(c) === lt) { const s = c.nextElementSibling; if (s && textOf(s)) return textOf(s); }
      }
      // 2: <dt> label, <dd> value
      for (const dt of document.querySelectorAll('dt')) {
        if (clean(dt) === lt) { const dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD' && textOf(dd)) return textOf(dd); }
      }
      // 4: <label> then adjacent <span>/element
      for (const l of document.querySelectorAll('label')) {
        if (clean(l) === lt) { const s = l.nextElementSibling; if (s && textOf(s)) return textOf(s); }
      }
      // 5: <div class*="label"> then adjacent value element
      for (const ld of document.querySelectorAll('[class*="label"]')) {
        if (clean(ld) === lt) { const s = ld.nextElementSibling; if (s && textOf(s)) return textOf(s); }
      }
      // 6: any element whose text IS the label, value = next sibling (different text)
      for (const el of document.querySelectorAll('th,td,dt,label,span,div,p,strong,b')) {
        if (clean(el) === lt) {
          const s = el.nextElementSibling;
          if (s && textOf(s) && clean(s) !== lt) return textOf(s);
        }
      }
      return null;
    }

    const out = {};
    for (const [field, variants] of Object.entries(labelMap)) {
      let val = null;
      for (const v of variants) { val = valueForLabel(v); if (val) break; }
      out[field] = val;
    }
    return out;
  }, FIELD_LABELS);
}

/**
 * Best-effort: navigate/click to a documents view reachable ON THE SAME
 * HOSTNAME. Cross-domain "Documents" links (e.g. a Northgate detail page that
 * links out to a separate comments/docs subsystem) are NOT followed — clicking
 * them navigates away from the application page into an unrelated system, which
 * is exactly how generic ended up on a comments page with fields=0/docs=0. Such
 * links are recorded for visibility and flagged as candidates for a dedicated
 * adapter. Returns { crossDomainDocLinks: [{ text, href }] }.
 */
async function tryOpenDocumentsTab(page, council, uid) {
  const crossDomainDocLinks = [];
  let initialHostname = '';
  try { initialHostname = new URL(page.url()).hostname; } catch { /* leave '' */ }

  for (const t of DOC_TAB_TEXTS) {
    try {
      // Anchor candidates: decide by resolved href hostname BEFORE clicking.
      const anchors = page.locator(`a:has-text("${t}")`);
      const aCount = await anchors.count().catch(() => 0);
      for (let i = 0; i < aCount; i++) {
        const a = anchors.nth(i);
        if (!(await a.isVisible().catch(() => false))) continue;
        const rawHref = await a.getAttribute('href').catch(() => null);
        // Hrefless / JS-driven anchors stay on the same host → treat as same-host.
        let linkHostname = initialHostname;
        let absHref = rawHref;
        if (rawHref) {
          try { const u = new URL(rawHref, page.url()); linkHostname = u.hostname; absHref = u.href; }
          catch { linkHostname = initialHostname; absHref = rawHref; }
        }
        if (linkHostname && initialHostname && linkHostname !== initialHostname) {
          const text = String(await a.innerText().catch(() => '') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          if (!crossDomainDocLinks.some(l => l.href === absHref)) {
            crossDomainDocLinks.push({ text, href: absHref });
            console.log(`[generic] ${council} ${uid}: skipping cross-domain Documents link (text="${text}" target="${linkHostname}") — not followed by generic; flag for adapter`);
          }
          continue; // do NOT click cross-domain
        }
        // Same hostname → click and stop.
        await a.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1500);
        return { crossDomainDocLinks };
      }
      // Button candidates: no href, in-page postback → same-host by nature.
      const btn = page.locator(`button:has-text("${t}")`).first();
      if ((await btn.count().catch(() => 0)) > 0 && await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1500);
        return { crossDomainDocLinks };
      }
    } catch { /* try next */ }
  }
  // Idox-style URL fallback (same-host by construction).
  const cur = page.url();
  if (/activeTab=/i.test(cur)) {
    const u = cur.replace(/activeTab=[^&]+/i, 'activeTab=documents');
    if (u !== cur) { await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); await page.waitForTimeout(1000); }
  } else if (/online-applications/i.test(cur)) {
    const j = cur.includes('?') ? '&' : '?';
    await page.goto(`${cur}${j}activeTab=documents`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  return { crossDomainDocLinks };
}

/** Find document links by file extension; dedupe by absolute URL. */
async function discoverDocuments(page, council, uid) {
  const { crossDomainDocLinks } = await tryOpenDocumentsTab(page, council, uid)
    .catch(() => ({ crossDomainDocLinks: [] }));
  console.log(`[diag-generic] After tab/link navigation, page.url() is: ${await page.url()}`);
  const docs = await page.evaluate((extSrc) => {
    const re = new RegExp(extSrc, 'i');
    const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      let href;
      try { href = new URL(a.getAttribute('href'), document.baseURI).href; } catch { continue; }
      const pathOnly = href.split('#')[0];
      if (!re.test(pathOnly)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      let name = norm(a.innerText) || norm(a.getAttribute('title'));
      if (!name) { try { name = decodeURIComponent(new URL(href).pathname.split('/').pop()); } catch { name = 'Document'; } }
      out.push({ name: name || 'Document', url: href });
    }
    return out;
  }, FILE_EXT_RE.source);
  return { docs, crossDomainDocLinks };
}

/** Keep at most MAX_DEBUG_FILES-1 html files under DEBUG_DIR (delete oldest). */
function enforceDebugCap() {
  if (!fs.existsSync(DEBUG_DIR)) return;
  const files = [];
  for (const council of fs.readdirSync(DEBUG_DIR)) {
    const cdir = path.join(DEBUG_DIR, council);
    let st; try { st = fs.statSync(cdir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(cdir)) {
      if (!f.endsWith('.html')) continue;
      const fp = path.join(cdir, f);
      try { files.push({ fp, mtime: fs.statSync(fp).mtimeMs }); } catch { /* skip */ }
    }
  }
  files.sort((a, b) => a.mtime - b.mtime); // oldest first
  while (files.length >= MAX_DEBUG_FILES) {
    const oldest = files.shift();
    try { fs.unlinkSync(oldest.fp); } catch { /* ignore */ }
  }
}

/** Save final page HTML to output/debug/<council>/<uid>.html (disk only). */
async function saveDebugHtml(page, council, uid) {
  try {
    const safeCouncil = String(council || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
    const safeUid = String(uid || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
    const dir = path.join(DEBUG_DIR, safeCouncil);
    fs.mkdirSync(dir, { recursive: true });
    enforceDebugCap();
    const html = await page.content().catch(() => '');
    fs.writeFileSync(path.join(dir, `${safeUid}.html`), html, 'utf8');
  } catch { /* debugging aid only — never throw */ }
}

// ── main ──────────────────────────────────────────────────────────────────────

/**
 * Generic harvester. Signature parallels the other adapters but takes the full
 * application (for source URL + debug naming). Returns:
 *   { documents, metrics, downloadAuth, metadata, extractionConfidence, scrapeStatusHint }
 * confidence here is DISCOVERY-based; the orchestrator finalizes it after the
 * shared download loop (it alone knows how many docs actually persisted).
 */
async function scrapeGenericDocuments(page, application, context, navUrl) {
  // Orchestrator (src/index.js) is the authority on the navigation target. Fall
  // back to the SOURCE url only — never docsUrl, which is council-published and
  // platform-inconsistent (Northgate councils publish a comments URL there).
  const url = navUrl || application.sourceUrl || application.source_url;
  const council = application.area || application.council || 'Unknown';
  const uid = application.title || application.application_uid || 'unknown';

  const result = {
    documents: [],
    metrics: { documentsFound: 0, fieldsExtracted: 0 },
    downloadAuth: undefined, // generic assumes public downloads
    metadata: { applicant_name: null, agent_name: null, case_officer: null },
    crossDomainDocLinks: [],
    extractionConfidence: 'failed',
    scrapeStatusHint: null,
  };

  if (!url) {
    console.log(`[generic] ${council}: no source URL — nothing to harvest`);
    return result;
  }

  // 1. Navigate (classify nav failures into terminal hints).
  try {
    console.log(`[diag-generic] About to page.goto: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}),
      page.waitForTimeout(1500),
    ]);
    console.log(`[diag-generic] After page.goto, page.url() is: ${await page.url()}`);
  } catch (err) {
    console.log(`[diag-generic] After page.goto, page.url() is: ${await page.url()}`);
    const msg = String(err && err.message || '');
    if (/timeout/i.test(msg)) {
      result.scrapeStatusHint = 'timeout';
      console.log(`[generic] ${council} ${uid}: page load timeout (${DEFAULT_TIMEOUT_MS}ms) — skipping`);
    } else {
      result.scrapeStatusHint = 'portal_unreachable';
      console.log(`[generic] ${council} ${uid}: portal unreachable (${msg.split('\n')[0]}) — skipping`);
    }
    return result;
  }

  // 2. Anti-bot / login gate (detect-and-record ONLY — never bypass).
  const gate = await detectGate(page);
  if (gate.blocked) {
    result.scrapeStatusHint = 'blocked_anti_bot';
    // Privacy: marker + council + skip action ONLY. Nothing else from the page.
    console.log(`[generic] ${council}: anti-bot marker '${gate.marker}' — skipping`);
    return result;
  }
  if (gate.login) {
    result.scrapeStatusHint = 'requires_auth';
    console.log(`[generic] ${council}: login wall detected ('${gate.marker}') — skipping`);
    return result;
  }

  // 3. Contact fields (values never logged — counts only).
  const raw = await extractFields(page).catch(() => ({}));
  result.metadata.applicant_name = cleanField(raw.applicant_name);
  result.metadata.agent_name = cleanField(raw.agent_name);
  result.metadata.case_officer = cleanField(raw.case_officer);
  const fieldsExtracted = ['applicant_name', 'agent_name', 'case_officer']
    .filter(k => result.metadata[k]).length;
  result.metrics.fieldsExtracted = fieldsExtracted;

  // 4. Document discovery (same-hostname only; cross-domain links recorded).
  const { docs, crossDomainDocLinks } = await discoverDocuments(page, council, uid)
    .catch(() => ({ docs: [], crossDomainDocLinks: [] }));
  result.documents = docs;
  result.metrics.documentsFound = docs.length;
  result.crossDomainDocLinks = crossDomainDocLinks;
  if (docs.length === 0 && crossDomainDocLinks.length > 0) {
    // Not a failure — field extraction still ran on the detail page. Document
    // discovery deliberately skipped a cross-domain docs subsystem.
    result.metrics.documentNote = 'cross_domain_docs_skipped';
  }

  // 5. Discovery confidence.
  const f = fieldsExtracted > 0;
  const d = docs.length > 0;
  result.extractionConfidence = (f && d) ? 'high' : (f || d) ? 'medium' : 'failed';

  // Save HTML for inspection on anything that isn't a clean full success.
  if (result.extractionConfidence !== 'high') {
    console.log(`[diag-generic] About to save debug HTML, page.url() is: ${await page.url()}`);
    await saveDebugHtml(page, council, uid).catch(() => {});
  }

  console.log(`[generic] ${council} ${uid}: fields=${fieldsExtracted} documentsFound=${docs.length} confidence=${result.extractionConfidence}`);
  return result;
}

module.exports = {
  scrapeGenericDocuments,
  cleanField,
  FILE_EXT_RE,
  PLACEHOLDERS,
};
