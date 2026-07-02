/**
 * adapters/salesforce.js
 *
 * Adapter for Salesforce-hosted "Arcus BE" public planning registers
 * (Haringey, and other councils on the same platform).
 *
 * Like Arcus, this uses a JSON (Aura) API rather than scraping the DOM, but it
 * keeps the scrapeIdoxDocuments(page, url) signature and { documents, metrics }
 * return shape so it drops into index.js unchanged. HTTP goes through
 * page.context().request to share the hardened browser session.
 *
 * Verified flow (Haringey, June 2026):
 *   recordId from URL: /pr/s/planning-application/{recordId}/...
 *   POST {origin}/pr/s/sfsites/aura?r=1&aura.ApexAction.execute=1
 *     -> ApexAction arcuscommunity/PR_FilesListCont.getFiles {recordId, registerName:null}
 *     -> returnValue[].returnValue = [{ Id, Title, Description, FileExtension,
 *          ContentSize, arcshared__Document_Date__c, ... }]
 *   GET {origin}/pr/sfc/servlet.shepherd/version/download/{Id}  -> the file
 *   (aura.token is null — no CSRF needed)
 *
 * PER-COUNCIL FRAGILITY (honest):
 *   - fwuid changes when the council's Salesforce org is upgraded.
 *   - namespace/classname differ per council. Haringey = arcuscommunity /
 *     PR_FilesListCont. Wiltshire rejected that class ("no access to Apex class
 *     PR_FilesListCont"), so other councils need their own config captured from
 *     a live aura call. Unknown councils fall back to Haringey defaults and will
 *     surface a clear AURA_FAILED error if the class differs.
 */

// Per-council Salesforce config. Add a council by capturing one live aura call
// (DevTools > Network > aura > Payload) and reading namespace/classname/fwuid.
const SF_CONFIG = {
  'publicregister.haringey.gov.uk': {
    namespace: 'arcuscommunity',
    classname: 'PR_FilesListCont',
    method: 'getFiles',
    fwuid: 'cmpKNldRZXRSMkdjemxQdjBkbl9uQWtVMjdnTGFERUU2S3FfSVdrcU92bkExNC4xOTIuODM4ODYwOA',
    // Contact/decision fields via a SEPARATE Aura ApexAction (Arcus PublicRegister
    // view service). fwuid/appVersion are NOT hardcoded here — they rotate on
    // Salesforce redeploys and are extracted fresh from the page HTML per run.
    // Verified against Haringey HGY/2024/0073 (June 2026 capture).
    detail: {
      method: 'ARCUS_APEX',
      apex: {
        namespace: 'arcuscommunity',
        classname: 'PublicRegisterViewService',
        method: 'getRecordDetails',
      },
      auraEndpointPath: '/pr/s/sfsites/aura',
      pageUriPathTemplate: '/pr/s/planning-application/{recordId}',
      fieldMap: {
        applicant_name: 'arcusbuiltenv__Applicant_Name__c',
        agent_name: 'arcusbuiltenv__Agent_Name__c',
        case_officer: 'arcusbuiltenv__Officer_Name__c',
        decision: 'arcusbuiltenv__Current_Decision__c',
        target_decision_date: 'arcusbuiltenv__Decision_Notice_Sent_Date_Manual__c',
      },
    },
  },
  // 'development.wiltshire.gov.uk': { namespace: '...', classname: '...', fwuid: '...' },
};

// Aura framework identifiers (fwuid + community app version) live in the page HTML
// and rotate on Salesforce redeploys — extract fresh, never hardcode.
const FWUID_REGEX = /"fwuid"\s*:\s*"([^"]+)"/;
const APP_VERSION_REGEX = /"APPLICATION@markup:\/\/siteforce:communityApp"\s*:\s*"([^"]+)"/;

// Per-run cache of { fwuid, appVersion } keyed by host, populated on the first app
// for that host in a run. Process-scoped only — never persisted to disk.
const auraFrameworkCache = new Map();

const DEFAULT_CONFIG = SF_CONFIG['publicregister.haringey.gov.uk'];

// ⚠️ CONTACT FIELDS ON SALESFORCE — REQUIRES A LIVE SAMPLE, NOT WIRED BY DEFAULT.
// The getFiles Aura action (PR_FilesListCont) returns FILE records only — it does
// NOT carry applicant/agent/case_officer/decision. Those live on the application
// DETAIL record, fetched by a DIFFERENT Aura ApexAction (a per-council detail
// controller: different namespace/classname/method than getFiles). We do NOT know
// that class for any council and MUST NOT guess it (a wrong class returns the same
// "no access to Apex class" error seen for Wiltshire's file class).
//
// To enable per council: capture one live detail aura call (DevTools > Network >
// aura > Payload) and add a `detail` block to that council's SF_CONFIG entry, e.g.:
//   detail: { namespace: 'arcuscommunity', classname: 'PR_ApplicationDetailCont',
//             method: 'getApplication', recordParam: 'recordId' }
// Then confirm the returned record's field API names and prune mapSalesforceMetadata.
// Until a `detail` block is present, this adapter returns no contact metadata (the
// fields stay null — adapterContacts skips nulls, so nothing is clobbered).

// First non-empty value among candidate keys on a Salesforce record.
function pickSf(rec, keys) {
  for (const k of keys) {
    const v = rec && rec[k];
    if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/**
 * Map contact/decision fields from a Salesforce application detail record.
 * ⚠️ FIELD API NAMES INFERRED — verify against a live detail record before relying.
 * @param {object} rec
 */
function mapSalesforceMetadata(rec) {
  if (!rec || typeof rec !== 'object') return null;
  return {
    applicant_name: pickSf(rec, ['ApplicantName__c', 'Applicant__c', 'Applicant_Name__c']),
    agent_name: pickSf(rec, ['AgentName__c', 'Agent__c', 'Agent_Name__c']),
    agent_company: pickSf(rec, ['AgentCompany__c', 'Agent_Company__c']),
    agent_address: pickSf(rec, ['AgentAddress__c', 'Agent_Address__c']),
    case_officer: pickSf(rec, ['CaseOfficer__c', 'Case_Officer__c', 'CaseOfficerName__c']),
    decision: pickSf(rec, ['Decision__c', 'DecisionType__c', 'Decision_Type__c']),
    target_decision_date: pickSf(rec, ['TargetDecisionDate__c', 'TargetDate__c', 'Determination_Date__c']),
    consultation_start_date: pickSf(rec, ['ConsultationStartDate__c', 'Consultation_Start_Date__c']),
  };
}

/**
 * Extract (and per-run cache) the Aura framework identifiers from the page HTML.
 * Uses the shared Playwright request context so it rides the guest session cookies.
 * @param {import('playwright').APIRequestContext} request
 * @param {string} host
 * @param {string} sampleSourceUrl a source_url for this host (first app in the run)
 * @returns {Promise<{fwuid: string, appVersion: string}>}
 */
async function fetchAuraFrameworkIds(request, host, sampleSourceUrl) {
  const cached = auraFrameworkCache.get(host);
  if (cached) return cached;

  console.log(`[salesforce] fetching Aura framework identifiers from ${sampleSourceUrl}`);
  const res = await request.get(sampleSourceUrl, { timeout: 30000 });
  if (!res.ok()) throw new Error(`page fetch HTTP ${res.status()}`);
  const html = await res.text();
  if (!html || typeof html !== 'string' || html.length < 1000) {
    throw new Error(`Salesforce page HTML too small or empty (${html ? html.length : 0} bytes)`);
  }

  const fwuidMatch = html.match(FWUID_REGEX);
  const appVersionMatch = html.match(APP_VERSION_REGEX);
  if (!fwuidMatch || !appVersionMatch) {
    throw new Error(
      `Failed to extract Aura framework identifiers from ${sampleSourceUrl} ` +
      `(fwuid=${!!fwuidMatch}, appVersion=${!!appVersionMatch})`
    );
  }

  const ids = { fwuid: fwuidMatch[1], appVersion: appVersionMatch[1] };
  auraFrameworkCache.set(host, ids);
  console.log(`[salesforce] cached Aura framework identifiers for ${host} (fwuid length=${ids.fwuid.length})`);
  return ids;
}

/** Build the form-encoded body for the Arcus detail Aura ApexAction. */
function buildAuraDetailRequest({ recordId, fwuid, appVersion, apex, pageUriPathTemplate, actionId = '1;a' }) {
  const message = {
    actions: [{
      id: actionId,
      descriptor: 'aura://ApexActionController/ACTION$execute',
      callingDescriptor: 'UNKNOWN',
      params: {
        namespace: apex.namespace,
        classname: apex.classname,
        method: apex.method,
        params: { recordId, registerName: null },
        cacheable: true,
        isContinuation: false,
      },
    }],
  };

  const auraContext = {
    mode: 'PROD',
    fwuid,
    app: 'siteforce:communityApp',
    loaded: { 'APPLICATION@markup://siteforce:communityApp': appVersion },
    dn: [],
    globals: { srcdoc: true },
    uad: true,
  };

  const pageURI = pageUriPathTemplate.replace('{recordId}', recordId);
  const body = new URLSearchParams({
    message: JSON.stringify(message),
    'aura.context': JSON.stringify(auraContext),
    'aura.pageURI': pageURI,
    'aura.token': 'null',
  });
  return body.toString();
}

/** Trim/normalize a raw Salesforce field value; date fields → ISO date-only or null. */
function normalizeSalesforceValue(fieldKey, raw) {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (!str) return null;
  if (fieldKey === 'target_decision_date' || fieldKey === 'consultation_start_date') {
    const dateOnly = str.split(/\s+/)[0];
    return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) ? dateOnly : null;
  }
  return str;
}

/**
 * Parse the Arcus getRecordDetails Aura response into our contact schema.
 * Envelope: { actions: [{ state, returnValue: { returnValue: { sections: [{ fields: [{name,value}] }] } } } ] }
 * @param {object} responseJson
 * @param {Record<string,string>} fieldMap ourField -> Salesforce API field name
 */
function parseAuraDetailResponse(responseJson, fieldMap) {
  const action = responseJson && responseJson.actions && responseJson.actions[0];
  if (!action || action.state !== 'SUCCESS') {
    throw new Error(`Aura action failed: state=${action && action.state}, error=${JSON.stringify((action && action.error) || null)}`);
  }
  const sections = action.returnValue && action.returnValue.returnValue && action.returnValue.returnValue.sections;
  if (!Array.isArray(sections)) {
    throw new Error('Unexpected Aura response shape: sections missing or not array');
  }

  // Flatten every field from every section into name -> value.
  const fieldValues = {};
  for (const section of sections) {
    for (const field of (section.fields || [])) {
      if (field && field.name != null) fieldValues[field.name] = field.value != null ? field.value : null;
    }
  }

  const result = {};
  for (const [ourField, apiName] of Object.entries(fieldMap)) {
    result[ourField] = normalizeSalesforceValue(ourField, fieldValues[apiName]);
  }
  return result;
}

function originOf(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; }
  catch { return null; }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

function recordIdOf(url) {
  const m = String(url).match(/planning-application\/([a-z0-9]{15,18})/i);
  if (m) return m[1];
  const m2 = String(url).match(/\/detail\/([a-z0-9]{15,18})/i); // Bracknell /s/detail/
  if (m2) return m2[1];
  const m3 = String(url).match(/\/([a-z0-9]{15,18})(?:[/?#]|$)/i);
  return m3 ? m3[1] : null;
}

function configFor(host) {
  return SF_CONFIG[host] || DEFAULT_CONFIG;
}

function downloadUrl(origin, fileId) {
  return `${origin}/pr/sfc/servlet.shepherd/version/download/${fileId}`;
}

/**
 * Main adapter. Signature matches scrapeIdoxDocuments(page, url).
 */
async function scrapeSalesforceDocuments(page, url) {
  const startTime = Date.now();
  const metrics = { totalRows: 0, validDocs: 0, runtimeMs: 0, success: false };

  const origin = originOf(url);
  const host = hostOf(url);
  const recordId = recordIdOf(url);

  if (!origin || !recordId) {
    metrics.runtimeMs = Date.now() - startTime;
    console.log(`[salesforce] Could not parse origin/recordId from: ${url}`);
    return { documents: [], metrics };
  }

  const cfg = configFor(host);
  const request = page.context().request;
  const auraUrl = `${origin}/pr/s/sfsites/aura?r=1&aura.ApexAction.execute=1`;

  const message = {
    actions: [
      {
        id: '1;a',
        descriptor: 'aura://ApexActionController/ACTION$execute',
        callingDescriptor: 'UNKNOWN',
        params: {
          namespace: cfg.namespace,
          classname: cfg.classname,
          method: cfg.method,
          params: { recordId, registerName: null },
          cacheable: true,
          isContinuation: false,
        },
      },
    ],
  };
  const auraContext = {
    mode: 'PROD',
    fwuid: cfg.fwuid,
    app: 'siteforce:communityApp',
    loaded: { 'APPLICATION@markup://siteforce:communityApp': '1' },
    dn: [],
    globals: { srcdoc: true },
    uad: true,
  };

  const form = new URLSearchParams({
    message: JSON.stringify(message),
    'aura.context': JSON.stringify(auraContext),
    'aura.pageURI': `/pr/s/planning-application/${recordId}`,
    'aura.token': 'null',
  });

  let rawDocs = [];
  try {
    const res = await request.post(auraUrl, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: '*/*',
        Origin: origin,
        Referer: `${origin}/pr/s/planning-application/${recordId}`,
      },
      data: form.toString(),
      timeout: 30000,
    });

    if (res.status() === 403 || res.status() === 429) {
      const e = new Error(`Salesforce blocked (HTTP ${res.status()})`);
      e.code = 'BLOCKED';
      throw e;
    }
    if (!res.ok()) throw new Error(`Aura HTTP ${res.status()}`);

    const data = await res.json();
    const action = data && data.actions && data.actions[0];
    if (!action) throw new Error('No action in aura response');
    if (action.state !== 'SUCCESS') {
      const msg = (action.error && action.error[0] && action.error[0].message) || action.state;
      // fwuid mismatch or wrong Apex class for this council surfaces here
      const e = new Error(`Aura action failed: ${msg}`);
      e.code = 'AURA_FAILED';
      throw e;
    }
    const rv = action.returnValue;
    rawDocs = rv && rv.returnValue ? rv.returnValue : rv;
    if (!Array.isArray(rawDocs)) rawDocs = [];
  } catch (err) {
    metrics.runtimeMs = Date.now() - startTime;
    if (err.code === 'BLOCKED') throw err; // let index.js mark blocked
    console.log(`[salesforce] ${host}: ${err.message}`);
    return { documents: [], metrics };
  }

  const documents = rawDocs
    .filter((d) => d.Id)
    .map((d) => ({
      name: d.Title || 'Document',
      type: d.Description || d.FileType || d.FileExtension || 'Document',
      date: d.arcshared__Document_Date__c || d.CreatedDate || null,
      url: downloadUrl(origin, d.Id),
      confidence: 'HIGH', // direct shepherd download
    }));

  // ── Contact/decision metadata via a SEPARATE Aura ApexAction ─────────────────
  // Arcus (running on this Salesforce Community) exposes contact/decision fields via
  // a different ApexAction (getRecordDetails) whose response is section/field shaped.
  // fwuid/appVersion are extracted fresh from the page HTML (they rotate on deploys)
  // and cached per host for the run. Best-effort: a failure here NEVER fails the
  // scrape — documents are the primary purpose, contacts are enrichment.
  let metadata = null;
  if (cfg.detail && cfg.detail.method === 'ARCUS_APEX') {
    try {
      const { fwuid, appVersion } = await fetchAuraFrameworkIds(request, host, url);
      const body = buildAuraDetailRequest({
        recordId,
        fwuid,
        appVersion,
        apex: cfg.detail.apex,
        pageUriPathTemplate: cfg.detail.pageUriPathTemplate,
      });
      const detailAuraUrl = `${origin}${cfg.detail.auraEndpointPath}?r=1&aura.ApexAction.execute=1`;
      console.log(`[salesforce] ${host} record ${recordId}: POSTing Aura detail request`);
      const dres = await request.post(detailAuraUrl, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: '*/*',
          Origin: origin,
          Referer: `${origin}/pr/s/planning-application/${recordId}`,
          'X-SFDC-Aura-Format': 'JSON',
        },
        data: body,
        timeout: 30000,
      });
      if (!dres.ok()) throw new Error(`Aura detail HTTP ${dres.status()}`);
      const ddata = await dres.json();
      metadata = parseAuraDetailResponse(ddata, cfg.detail.fieldMap);
      console.log(`[salesforce] ${host} record ${recordId}: contact fields extracted: ${JSON.stringify(metadata)}`);
    } catch (err) {
      // Do NOT throw — documents already succeeded; contact fields are best-effort.
      console.log(`[salesforce] ${host} record ${recordId}: contact field extraction failed: ${err.message}`);
    }
  } else {
    console.log(`[salesforce] ${host}: contact fields NOT extracted — no verified detail Aura config for this council (add SF_CONFIG[host].detail).`);
  }

  metrics.totalRows = rawDocs.length;
  metrics.validDocs = documents.length;
  metrics.runtimeMs = Date.now() - startTime;
  metrics.success = documents.length > 0;

  console.log(`[salesforce] ${host} record ${recordId}: ${documents.length} document(s) in ${metrics.runtimeMs}ms`);

  // The shepherd download endpoint (/pr/sfc/servlet.shepherd/version/download/{Id})
  // is served to the SAME (guest) session that the aura call ran under. The aura
  // POST above went through page.context().request, so the context now holds the
  // guest session cookies — capture them so downloadManager can carry them to the
  // download. Also pass Origin/Referer (the page the request appears to come from).
  //
  // HONEST NOTE: Salesforce community downloads are session-bound. The cookies
  // path is the load-bearing one here (a session cookie, not a header). If guest
  // downloads still fail, this likely needs an authenticated session cookie or a
  // CSRF token captured from a real browser visit — flag for manual testing.
  let cookies = [];
  try {
    cookies = await page.context().cookies();
  } catch (err) {
    console.log(`[salesforce] Could not read context cookies for downloadAuth: ${err.message}`);
  }
  const downloadAuth = {
    headers: {
      Origin: origin,
      Referer: `${origin}/pr/s/planning-application/${recordId}`,
    },
    cookies,
  };

  return { documents, metrics, metadata: metadata || undefined, downloadAuth };
}

module.exports = {
  scrapeSalesforceDocuments,
  recordIdOf,
  configFor,
  SF_CONFIG,
  mapSalesforceMetadata,
  pickSf,
  // Arcus/Salesforce contact-field extraction (exported for unit tests):
  buildAuraDetailRequest,
  parseAuraDetailResponse,
  normalizeSalesforceValue,
  fetchAuraFrameworkIds,
  auraFrameworkCache,
  FWUID_REGEX,
  APP_VERSION_REGEX,
};
