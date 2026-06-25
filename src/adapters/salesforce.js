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
  },
  // 'development.wiltshire.gov.uk': { namespace: '...', classname: '...', fwuid: '...' },
};

const DEFAULT_CONFIG = SF_CONFIG['publicregister.haringey.gov.uk'];

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

  return { documents, metrics, downloadAuth };
}

module.exports = {
  scrapeSalesforceDocuments,
  recordIdOf,
  configFor,
  SF_CONFIG,
};
