# Phase 3 Implementation Design (design only — no code)

Two deliverables shipping together:
- **Part A** — `capita-planning-case` adapter (first no-Playwright adapter).
- **Part B** — Pattern C document change detection (cross-cutting, all adapters).

Designed together because Capita must be re-check-compatible from day 1.
Approved design decisions 1–5 (from Phase 3a review) are folded in below.

---

## PART A — Capita adapter

### A.a File
`src/adapters/capita-planning-case.js` — pure HTTP (Node 18+ `fetch` + a tiny
manual cookie jar). No Playwright, no `browser`, no `context`.

### A.b Signature
```
async function scrapeCapitaDocuments(application, navUrl)
  -> { documents, metrics, metadata, downloadAuth, scrapeStatusHint }
```
- `application` — the Planit app object (for `title` → ref, debug naming).
- `navUrl` — the resolved nav target from the orchestrator (`scrapeUrl`).
- No `page`, no `context` (mirrors roadmap §2g). `downloadAuth: undefined`
  (public stateless files).

Return shape (matches existing adapters):
```
{
  documents: [{ name, type, date, url, confidence: 'HIGH' }],
  metrics:   { totalRows, validDocs, runtimeMs, success, partial },
  metadata:  { address, case_no, status, dev_description,
               applicant_name: null, agent_name: null, case_officer: null },
  downloadAuth: undefined,
  scrapeStatusHint: null | 'requires_different_path' | 'portal_unreachable'
                    | 'no_documents' | 'timeout' | 'blocked_anti_bot'
}
```

### A.c Pseudocode

**Ref extraction** (single source of truth, top of the adapter):
```
function extractCaseRef(application):
  raw = application.title || application.application_uid || ''
  // Planit titles look like "Wandsworth/2024/4485" or "Wandsworth/2024/4485/FUL".
  // The Capita case= param wants the COUNCIL-LOCAL ref: everything after the
  // leading "{Council}/". Strip exactly one leading authority segment.
  // Edge cases:
  //   "2024/4485"            -> "2024/4485"      (no authority prefix)
  //   "Wandsworth/2024/4485" -> "2024/4485"
  //   "Wandsworth/2024/4485/FUL" -> "2024/4485/FUL" (keep suffix; the portal uses it)
  //   ""/null                -> null -> caller returns requires_different_path
  m = raw.match(/^[A-Za-z][\w .'-]*\/(.+)$/)   // leading authority word + "/"
  ref = m ? m[1] : raw
  ref = ref.trim()
  return ref || null
  // NOTE: we PREFER the ref baked into the resolved comments URL (Step 0) when
  // present — extractCaseRef is the fallback when we must build the URL ourselves.
```

**Step 0 — resolve the comments URL:**
```
if navUrl contains 'planningcase/comments.aspx':
    commentsUrl = navUrl              // already have it; ref is in ?case=
    ref = parse 'case=' param from navUrl  (fallback to extractCaseRef)
else:
    // navUrl is a Northgate detail page. GET it, find the footer anchor.
    html = await httpGet(navUrl)            // with timeout + try/catch
    href = first anchor matching /planningcase\/comments\.aspx\?case=/i
    if !href:
        scrapeStatusHint = 'requires_different_path'
        log "[capita] <council> <ref>: no Capita comments link on detail page — flag for adapter"
        return empty result
    commentsUrl = absolute(href, navUrl)
    ref = parse 'case=' from commentsUrl
host = new URL(commentsUrl).host        // the planning2.* Capita host
```
Network failures in any GET/POST → `scrapeStatusHint='portal_unreachable'`
(or `'timeout'` if the error is a timeout) → return empty.

**Step 1 — GET comments.aspx, parse initial state:**
```
resp = await httpGet(commentsUrl, jar)   // jar captures Set-Cookie (ASP.NET_SessionId)
html = resp.body
detectGate(html)  // anti-bot markers -> scrapeStatusHint='blocked_anti_bot', return
metadata = {
  address:         text of #lblAddress,
  case_no:         text of #lblCaseNo,
  status:          text of #lblStatus,
  dev_description: text of #lblDevDesc,
  applicant_name: null, agent_name: null, case_officer: null,  // not on this page
}
viewstate = hidden #__VIEWSTATE
viewstategen = hidden #__VIEWSTATEGENERATOR
eventvalidation = hidden #__EVENTVALIDATION
categories = parse gvDocs rows -> [{ ctlId, label, count }]   // postback targets
docids = parse gvResults rows -> [{ docid, name, type }]      // currently-shown category
```

**Step 2 — `__doPostBack` loop over remaining categories:**
```
for cat in categories where cat.count > 0 and cat not already shown:
    body = urlencode({
      __EVENTTARGET: cat.ctlId, __EVENTARGUMENT: '',
      __VIEWSTATE: viewstate, __VIEWSTATEGENERATOR: viewstategen,
      __EVENTVALIDATION: eventvalidation,
    })
    resp = await httpPost(commentsUrl, body, jar)   // same cookie jar
    if resp failed or event-validation rejected:
        metrics.partial = true
        log "[capita] <ref>: category postback failed; returning partial"
        continue        // keep what we have; do NOT fail the whole app
    // thread the FRESH hidden fields forward (sequential, browser-like)
    viewstate, viewstategen, eventvalidation = re-parse from resp.body
    docids += parse gvResults from resp.body
dedupe docids by docid
```

**Step 3 — build document records:**
```
for d in docids:
    url = `https://${host}/IAM/IAMLink.aspx?docid=${d.docid}`   // see A.g — chosen if stateless
    documents.push({ name: d.name, type: d.type, date: d.date || null,
                     url, confidence: 'HIGH' })
metrics.totalRows = categories sum of counts
metrics.validDocs = documents.length
metrics.success = documents.length > 0 || metadata has any lbl*  // page reached & parsed
if documents.length == 0: scrapeStatusHint = 'no_documents'   // page OK, empty docs table
```

**Step 4 — return.** Orchestrator runs the shared `downloadManager` loop with
`extraction_method='capita-planning-case'`, `context=null`, `knownUrls` (Part B).

### A.d Detection update
`src/detector.js` — `routeAdapter()` learns `capita`. `detectPlatform()` UNCHANGED
(still returns `northgate`/`unknown`, so `applications.platform` stays truthful).
```
function routeAdapter(url):
  platform = detectPlatform(url)
  if platform in (idox, arcus, salesforce): return platform
  // Capita comments pattern (cross-domain docs subsystem). String match only.
  if /planningcase\/comments\.aspx/i.test(url): return 'capita'
  return 'generic'
```
Honest gap: when the source is a Northgate *detail* URL (no `planningcase/` yet),
`routeAdapter` returns `generic`, not `capita` — the comments link is only
discoverable after a GET. **Two options, decide in 3c:**
- (i) Keep it simple: route such councils to `capita` via an explicit opt-in list
  (mirrors `GENERIC_COUNCILS`) — but that's per-council config, which we avoid.
- (ii) Let `generic` detect the cross-domain `planningcase` link it already records
  (`crossDomainDocLinks`) and *defer* to capita. More plumbing.
- **Recommended:** for first ship, route on the `planningcase/comments.aspx`
  string only (covers the case where Planit's `docsUrl`/source already carries it,
  e.g. Wandsworth). Northgate-detail-only councils fall to `generic` and surface
  the cross-domain link for follow-up. No per-council code. Documented limit.

### A.e index.js new branch (exact location)
Insert a new `else if (adapter === 'capita')` branch **between** the
`salesforce` branch (ends L329) and the `generic` branch (begins L331). It does
**NOT** init `browser`/`context`:
```
} else if (adapter === 'capita') {
  try {
    docsObject = await scrapeCapitaDocuments(app, scrapeUrl);   // no page, no context
    success = docsObject.metrics && docsObject.metrics.success;
  } catch (err) {
    error = err; success = false;
    runManager.log(`Capita extraction error: ${err.message}`, 'ERROR');
  }
}
```
- `BROWSER_PLATFORMS` is **unchanged** (`['idox','arcus','salesforce','generic']`),
  so the download loop (L397) passes `context=null` for capita automatically, and
  the context-close block (L428) skips it.
- The Idox/Arcus/Salesforce/Generic branches are **byte-for-byte unchanged** — the
  3c diff will prove this (the new branch is purely additive).

### A.f Status enum mapping (Capita hint → scrape_status)
Capita uses the generic-style `scrapeStatusHint` channel. In index.js the
`scrapeStatus` selection (L363–368) gets a capita arm:
```
if adapter === 'capita':
    scrapeStatus = docsObject.scrapeStatusHint
                   || (success ? 'scraped' : 'failed')
```
| adapter hint | scrape_status |
|---|---|
| `null` + success | `scraped` |
| `requires_different_path` | `requires_different_path` |
| `no_documents` | `no_documents` (NEW value, doc'd) |
| `portal_unreachable` | `portal_unreachable` |
| `timeout` | `timeout` |
| `blocked_anti_bot` | `blocked_anti_bot` |
| partial categories | `scraped` + `metrics.partial=true` (no separate status) |

> Note: your DECISION 5 maps `no_documents` onto `scraped`+`validDocs=0`. The
> adapter return shape already carries `scrapeStatusHint='no_documents'`; I
> recommend **persisting `no_documents` as its own status** (it's already in your
> enum list and it's more honest than a `scraped` row with zero docs). Flagging the
> discrepancy — will follow your call in 3c. Default to persisting `no_documents`.

### A.g URL strategy testing plan (3c, before integration)
Goal: pick ONE download URL form, prefer the type-agnostic redirector.
1. From a fresh **Incognito** (no session), curl/fetch both forms for the SAME docid:
   - `https://{host}/IAM/IAMLink.aspx?docid={ID}`
   - `https://{host}/iam/IAMCache/{ID}/{ID}.pdf`
2. Test for **both a PDF doc and a non-PDF doc** (Plans/Drawings → TIFF/DWG).
3. Record HTTP status, `content-type`, and whether bytes return without a session
   cookie (statelessness) in `docs/era-testing-results.md`.
4. **Decision rule:** prefer `IAMLink.aspx?docid=` iff it is **stateless AND
   type-agnostic** (correct content-type for non-PDF). Else fall back to
   `IAMCache/{ID}/{ID}.pdf` and accept the PDF-only caveat (log non-PDF categories).
5. Document the chosen strategy + evidence in `docs/capita-planning-case.md`.

### A.h Era testing plan (3c)
Pick **5+ Wandsworth applications spanning 2018–2024** (e.g. 2018, 2020, 2021,
2023, 2024/4485). For each: run the adapter (static/offline-fetch, not the full
pipeline), record:
- comments link found? VIEWSTATE postbacks ok? docids count? download 200?
- Pre-Capita era → expect a clean `requires_different_path` (no crash).
Report per-era success in `docs/era-testing-results.md`. Honest read: if older
eras consistently fail, that's a documented era boundary, not a bug.

---

## PART B — Change detection

### B.a Migration `supabase/migrations/007_change_detection.sql` (NOT applied)
```sql
alter table public.applications
  add column if not exists last_checked_at timestamptz,
  add column if not exists documents_last_changed_at timestamptz,
  add column if not exists is_terminal boolean default false,
  add column if not exists recheck_count integer default 0;

create index if not exists idx_applications_recheck
  on public.applications (is_terminal, last_checked_at)
  where is_terminal = false;

alter table public.documents
  add column if not exists first_seen_at timestamptz default now(),
  add column if not exists last_seen_at timestamptz default now(),
  add column if not exists status text default 'active'; -- 'active' | 'removed'
```
Idempotent (`add column if not exists`). You apply manually after review.

### B.b `src/utils/terminalStatus.js`
```
const TERMINAL_STATUSES = new Set([
  'decided', 'refused', 'granted', 'permitted', 'approved',
  'withdrawn', 'application withdrawn', 'decision issued',
  'application permitted', 'application refused',
  'application granted', 'finally disposed of',
]);

function isTerminalStatus(status):
  if !status: return false          // null/empty = active (safer to re-check)
  return TERMINAL_STATUSES.has(String(status).trim().toLowerCase())

module.exports = { isTerminalStatus, TERMINAL_STATUSES }
```
UNKNOWN/unlisted status → active (re-checked). Used by orchestrator (decide
re-check) and `mapApplication` (set `is_terminal` — see B.c exception rules).

### B.c `mapApplication` signature change (DECISION 2)
**Before:** `mapApplication(app = {})` — emits every column incl. explicit
null/`??` defaults.
**After:** `mapApplication(app = {}, opts = {})` — same body, **plus** three
conditionally-included keys built into a `row` then augmented:
```
row = { ...all existing columns... }   // UNCHANGED

// last_checked_at: always stamped on every upsert (it WAS just checked/seen).
row.last_checked_at = opts.now || new Date()   // 'now' injectable for tests

// is_terminal: included ONLY when status is known AND terminal. Else OMITTED
// (preserves existing DB value — a thin upsert never flips a terminal app back).
if (app.status && isTerminalStatus(app.status)) row.is_terminal = true

// documents_last_changed_at: included ONLY when caller signals a change.
if (opts.documentsChanged === true) row.documents_last_changed_at = opts.now || new Date()

// recheck_count: included ONLY when caller passes a number.
if (typeof opts.recheckCount === 'number') row.recheck_count = opts.recheckCount

return row
```
- Existing call sites pass **no opts** → behavior unchanged **except** they now
  also stamp `last_checked_at`. (Acceptable: every upsert is a "we touched this
  app" event. Confirm OK — alternative is to gate last_checked_at behind opts too.)
- `is_terminal` default `false` lives in the DB (migration), so first-ever insert
  of a non-terminal app is `false` without us emitting it. Emitting `true` only
  when terminal means we never overwrite a DB `true` with `false`.
- ⚠️ One subtlety to confirm in 3c: a genuine **terminal→reopened** transition
  (rare) won't be un-flagged automatically, since we never emit `is_terminal=false`.
  Acceptable for first ship (re-opens are rare; manual fix). Documented limitation.

### B.d `mapDocument` signature change (DECISION/audit #6)
**Before:** emits `first_seen_at`? No (column is new). 
**After:** in `mapDocument`'s returned row:
```
// first_seen_at: OMITTED from the row entirely. DB default now() sets it on
// INSERT; on UPSERT-update the column is left untouched (we don't send it).
// last_seen_at: ALWAYS emitted -> updated to now() on every upsert.
last_seen_at: doc.last_seen_at || new Date(),
// status: emitted as 'active' for now. (Phase 5 owns 'removed'.)
status: doc.status || 'active',
```
No signature change to `mapDocument` needed (reads from `doc`); orchestrator/
downloadManager already build the doc object. `now` not injected here (low value).

### B.e `downloadManager` signature change (DECISION 1)
**Before:**
```
downloadDocument(doc, application, council, manifest,
                 context=null, downloadAuth=null, extractionMethod=null)
```
**After:** add `knownUrls` (a Set) as the **last** optional param:
```
downloadDocument(doc, application, council, manifest,
                 context=null, downloadAuth=null, extractionMethod=null,
                 knownUrls=null)
```
Behavior: at the top of `downloadDocument`, before any network work:
```
if (knownUrls && knownUrls.has(doc.url)):
    log "[dedup] skipping known url (already downloaded in a prior run)"   // url not logged in full? -> log host+path only
    resultRecord.status = 'skipped_known'    // NEW download status (see B.e.1)
    return resultRecord                       // no fetch, no upload, no upsert change
```
- Existing callers (resume fast-path L212, standalone `processDownloads` L484)
  pass no `knownUrls` → unchanged.
- Intra-run SHA-256 dedup (L370) still runs on everything NOT skipped.

**B.e.1 New download status `skipped_known`:** `runManager.recordDownload`
gets an arm that counts it separately (neither completed nor failed nor
duplicate). Surfaced in the run summary as `downloadsSkippedKnown`.

**B.e.2 finally-block note:** `downloadDocument`'s `finally` upserts the document
row (`last_seen_at` bump). For a `skipped_known` early-return we bypass `finally`'s
network work but the `return` still runs `finally`. We DO want `last_seen_at`
bumped for a still-present doc — so the finally upsert on the existing
`resultRecord` (carrying `doc` fields) is desirable. Confirm: the early return's
`resultRecord` has `sourceUrl=doc.url` and enough to resolve the row → `last_seen_at`
updates, `status` stays `active`. Good. (If we'd rather skip the upsert entirely on
`skipped_known`, that's a 1-line guard — flag for 3c. Default: bump last_seen_at.)

### B.f index.js new per-application loop order (DECISION 3) — pseudocode
```
for app in queue:
  # 1. Postcode filter (UNCHANGED, L181)
  if !shouldProcess(app): upsert skipped_filter; continue

  # 2. NEW: terminal check + knownUrls (before resume fast-path)
  existing = await applicationsRepository.findByUid(app.title)   # 1 round-trip
  knownUrls = new Set()
  recheckCount = 0
  if existing:
      recheckCount = (existing.recheck_count || 0) + 1
      if existing.is_terminal === true:
          upsert({ ...applyPlanitMetadata(app), scrape_status: 'skipped_terminal' },
                 { recheckCount })            # stamps last_checked_at + recheck_count
          runManager.log("skipping terminal application: " + app.title)
          results.push({ ...app, platform: existing.platform, scrape_status:'skipped_terminal', documents: [] })
          continue
      # active: gather known doc urls for cross-run skip
      docs = await documentsRepository.listDocuments({ applicationId: existing.id, pageSize: 1000 })  # 1 round-trip
      knownUrls = new Set(docs.data.map(d => d.source_url))

  # 3. Status upsert (UNCHANGED, L197) — pass {recheckCount} so re-checks count
  upsert({ ...applyPlanitMetadata(app), scrape_status: app.skipped_resume?'skipped_resume':'queued' },
         { recheckCount })

  # 4. Resume fast-path (UNCHANGED logic, L202) — now AFTER terminal check.
  #    Pass knownUrls to its downloadDocument calls too (skip re-download).
  if app.skipped_resume:
      for doc in docsList: downloadDocument(..., knownUrls); ...
      continue

  # 5. Detect/route (UNCHANGED, L232-255)
  # 6. generic_disabled gate (UNCHANGED, L260)
  # 7. Adapter branch (UNCHANGED for idox/arcus/sf/generic; NEW capita branch A.e)
  # 8. Download loop (L392) — pass knownUrls as the new last arg:
  for doc in documents:
      downloadDocument(doc, app, council, manifest,
                       BROWSER_PLATFORMS.includes(adapter)?context:null,
                       downloadAuth, adapter, knownUrls)

  # 9. NEW: change detection (DECISION 4, after download loop)
  adapterUrls = new Set(documents.map(d => d.url))
  newUrls     = [...adapterUrls].filter(u => !knownUrls.has(u))
  missingUrls = [...knownUrls].filter(u => !adapterUrls.has(u))
  documentsChanged = newUrls.length>0 || missingUrls.length>0
  runManager.log(`[change] ${app.title}: +${newUrls.length} -${missingUrls.length}`)  # counts only

  # 10. Post-scrape upsert (L370) — pass change-detection opts:
  upsert({ ...applyPlanitMetadata(app), ...adapterContacts(docsObject),
           platform, scrape_status: scrapeStatus },
         { documentsChanged, recheckCount })
```
- `documentsChanged` for a **first-time** app: `knownUrls` empty, so every found
  doc is "new" → `documentsChanged=true` → `documents_last_changed_at=now()`. Correct
  (first capture is a change from nothing).
- Two extra queries per app (`findByUid`, `listDocuments`) — accepted cost.

### B.g Resume path interaction (explicit)
- Terminal check (step 2) now precedes the resume fast-path (step 4), so a terminal
  app in `results.json` is skipped via `skipped_terminal` and **never** re-downloaded
  by the fast-path. (Fixes audit risk #3.)
- `DISABLE_RESUME=true` skips only the `results.json` carry-over; the DB terminal
  check and knownUrls logic are independent and still run.
- Resume fast-path now also receives `knownUrls` → it won't re-download docs already
  in the DB (the common case for a resumed item), making resume cheaper too.

### B.h Documents change detection — see B.f step 9 (pseudocode above).
- `missingUrls`: **logged only** this phase. No `documents.status='removed'` writes
  (Phase 5). Counts only in logs (privacy: never log URLs/personal data — log host or
  just the count; final form in 3c).

### B.i First-run behavior (post-migration)
- All existing rows: `is_terminal=false` (DB default) → all re-checked on the first
  post-migration run (expensive, one-time). After it, terminal apps flip to
  `is_terminal=true` and drop out of daily re-checks.
- `knownUrls` is populated from the DB on that first run too, so even the first
  re-check **won't re-download** docs already persisted from earlier runs — mitigating
  the "expensive first run" more than the original spec assumed. Net: first run is
  expensive in *adapter navigations* (it visits every active app) but cheap in
  *downloads* (knownUrls skip). Documented.

---

## 3. Intersection check (A × B)
- Capita branch (A.e) sits inside the same loop; its download loop (B.f step 8)
  passes `knownUrls` exactly like the other adapters → cross-run skip works for
  Capita with **zero Capita-specific change-detection code**.
- Capita apps carry Planit `status` (folded by `applyPlanitMetadata`), so the
  `is_terminal` check (B.c) and `skipped_terminal` path apply uniformly.
- Capita returns `documents[].url` (the IAMLink/IAMCache URL) → `adapterUrls`
  comparison (B.f step 9) is identical to other adapters. No special-casing.
- `downloadDocument(context=null, ..., knownUrls)` — the new `knownUrls` arg is
  positionally after `extractionMethod`; capita passes `context=null` as today.

## 4. Effort breakdown (honest)
| Item | Estimate |
|---|---|
| Part A — capita adapter (HTTP, cookie jar, postback loop, parse) | 6–9 h |
| Part A — routeAdapter + index.js branch + status mapping | 1 h |
| Part B — migration + terminalStatus.js | 1 h |
| Part B — mapApplication/mapDocument/downloadManager edits | 2–3 h |
| Part B — index.js loop reorder + change detection + runManager status | 2–3 h |
| Testing — URL strategy + era (Part A), smoke tests, change-detection dry runs | 4–6 h |
| Docs — capita-planning-case.md, change-detection.md, era-testing-results.md | 2 h |
| **Total** | **~18–25 h (≈2.5–3 focused days)** |

## 5. Phase 5 future-work callout (deferred — not built now)
- **Adaptive re-check frequency** — apps unchanged 30+ days → weekly, not daily.
- **Periodic full re-download** — catches same-URL content swaps that `knownUrls`
  skip misses (DECISION 1 limitation).
- **Removed-document detection** — write `documents.status='removed'` for
  `missingUrls` (currently logged only).
- **List-only adapter mode** — adapters expose a cheap "IDs only" path so re-checks
  skip full scrape when document IDs are unchanged.
- **Capita contact-fields secondary fetch** — second GET to the Northgate detail
  page for applicant/agent/case_officer (not on the comments page).
- **Capita routing for Northgate-detail-only councils** — auto-defer from generic's
  `crossDomainDocLinks` to capita (A.d option ii).

---

## Open items for your call before 3c
1. **A.d routing** — confirm "route on `planningcase/comments.aspx` string only"
   for first ship (Northgate-detail-only councils fall to generic). Recommended.
2. **A.f `no_documents`** — persist as its own `scrape_status` (recommended) vs
   DECISION 5's "map to scraped + validDocs=0". 
3. **B.c `last_checked_at`** — OK to stamp on *every* upsert (incl. filter/queued
   sites), or gate behind opts so only the terminal-check + post-scrape sites stamp it?
4. **B.e.2** — on `skipped_known`, bump `last_seen_at` via the finally upsert
   (recommended) vs skip the upsert entirely.

STOP — awaiting design review before Phase 3c.
