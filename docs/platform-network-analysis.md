# Platform Network Analysis (Phase 1)

**Goal:** stop scraping what pages _render_, start replaying what pages _fetch_.
For each platform: document the HTTP traffic behind the "Documents" view, how
each file actually downloads, and what session/auth state is required — so Phase 2
can decide which platforms get a thin API-client adapter.

**Date:** 2026-06-29
**Method (honest):** This environment has no human-driven Chrome DevTools session.
Per the agreed "probe-only, no guessing" rule, every fact below is one of:

| Tag | Meaning |
|-----|---------|
| `VERIFIED-CODE` | Real endpoint/headers/body already captured from DevTools and encoded in an existing adapter (`src/adapters/*.js`). Highest confidence. |
| `LIVE-PROBE` | Observed just now via raw `curl` (no JS execution). Faithful for server-rendered HTML and public REST APIs. Blind to anything a SPA fetches client-side. |
| `NEEDS-CAPTURE` | Genuinely not observable without a real browser DevTools/HAR capture. Stated as unknown — **not** guessed. A capture checklist is at the end of this doc. |

No documentation-derived API shapes are presented as fact. Where `curl` went
blind (JS-gated lists), the finding is `NEEDS-CAPTURE`, full stop.

---

## Summary table

| Platform | Documents transport | Download mechanism | Auth needed | Replay outside browser? | Adapter effort | Coverage |
|----------|--------------------|--------------------|-------------|------------------------|----------------|----------|
| **Idox** | Server-rendered HTML (`activeTab=documents`) | **Direct PDF URL** in HTML (`/files/{hash}/pdf/…`) | None observed (some councils Cloudflare-fronted) | **YES** (pure `curl`) | Small (built; HTML is already clean) | ~200+ councils |
| **Arcus** | JSON API (`/api/application/{id}/document`) | Per-doc token call (`/api/application/document/{hash}`) | Custom `x-client/x-product/x-service` headers | **YES** | Small (built) | ~9 councils |
| **Salesforce** | Aura ApexAction POST (`PR_FilesListCont.getFiles`) | Session-bound shepherd download (`/sfc/servlet.shepherd/version/download/{Id}`) | Guest session cookies + per-council `fwuid`/class | **YES, with caveats** | Medium (built; per-council fragility) | ~1 confirmed (Haringey) |
| **Socrata** | Public SODA REST (`/resource/{id}.json`) | **None — no documents on platform** | None | **YES for metadata; N/A for docs** | Small (metadata only) | Metadata only (overlaps Planit) |
| **Northgate** | Detail = server HTML; **docs = separate JS/postback subsystem** | `NEEDS-CAPTURE` | `NEEDS-CAPTURE` | **UNKNOWN** | Unknown until captured | ~12 councils (if clean call exists) |
| Tascomi / Civica / Atrium | Not investigated this pass | — | — | — | — | — |

---

## IDOX

Test application: **Croydon 13/02527/P** (Cane Hill Hospital redevelopment)
`https://publicaccess3.croydon.gov.uk/online-applications/applicationDetails.do?activeTab=documents&keyVal=ZZZW0QJLXB211`

### Network calls on "Documents" click:  `LIVE-PROBE`

1. **GET** `…/online-applications/applicationDetails.do?activeTab=documents&keyVal={KEYVAL}`
   - Headers: ordinary browser headers; `User-Agent` set, **no cookies required** in this probe.
   - Body: none.
   - Response Content-Type: `text/html`
   - Response shape: a complete server-rendered HTML page (~254 KB) containing
     `<table id="Documents" summary="Documents">`, one `<tr>` per document, each
     row carrying a **direct PDF anchor**:
     ```
     /files/058B27E91D5EA8F802701623CB876C55/pdf/13_02527_P-DEED_OF_VARIATION_DATED_22_AUGUST_2016-2799196.pdf
     /files/04991AF2EDB21AA7D7F35C91488971D4/pdf/13_02527_P-Decision_Notice-1167347.pdf
     …(20+ links pulled by curl alone, no JS)
     ```
   - No `/api/`, `.json`, `XMLHttpRequest`, or `fetch(` markers in the page — there
     is **no underlying JSON API**; the HTML _is_ the data.

### Document download mechanism:

- **Direct URL in the response (best case).** Each file is a stable
  `/files/{32-hex-hash}/pdf/{human-name}.pdf` path. No tokenisation, no per-doc
  API call, no session binding observed — the URL is self-contained and looks
  CDN/cacheable.

### Auth/session requirements:

- None observed for Croydon (a cookie-less `curl` with a normal UA returned the
  full table). **Honest caveat:** a subset of Idox councils sit behind Cloudflare
  / managed challenges (`browserChallenges.js` already handles this) — those need
  a real browser session, not raw HTTP. So "no auth" is the common case, not universal.

### Verdict:

- Replay outside the browser? **YES** — pure HTTP. `curl` reproduced the entire
  document list and the direct download URLs with zero JS.
- Effort to build an API client adapter: **Small.** Already built as an HTML
  adapter (`idox.js`). Phase 2 question worth raising: because the docs tab is
  fully `curl`-able, non-challenged Idox councils could be served by a **headless
  HTTP client** (no Playwright) — faster and cheaper — falling back to the browser
  adapter only when a challenge is detected.
- Coverage if we build it: **~200+ councils** (Idox PublicAccess is the dominant
  UK platform; the existing adapter already proves ~104).

---

## ARCUS

Test application: **Islington** (Agile Applications Citizen Portal)
`https://planning.agileapplications.co.uk/{council}/application-details/{id}`

### Network calls on "Documents" click:  `VERIFIED-CODE` (`src/adapters/arcus.js`)

1. **GET** `https://planningapi.agileapplications.co.uk/api/application/{id}/document`
   - Headers (essential):
     - `x-client: {PER-COUNCIL CODE}`  — **not** the URL slug (Islington = `IS`, not `ISLINGTON`)
     - `x-product: CITIZENPORTAL`
     - `x-service: PA`
     - `Accept: application/json`
   - Body: none.
   - Response Content-Type: `application/json`
   - Response shape: JSON array of documents:
     ```json
     [{ "documentHash": "…", "name": "…", "mediaDescription": "…", "receivedDate": "…" }]
     ```
2. (metadata, optional) **GET** `…/api/application/{id}` → application metadata.

### Document download mechanism:

- **Separate token call per document (Arcus pattern):**
  **GET** `https://planningapi.agileapplications.co.uk/api/application/document/{documentHash}`
  — the `documentHash` from the list is the token. **Requires the same `x-*`
  headers as the list call** (without them the file fetch is HTTP 401).

### Auth/session requirements:

- Custom headers only — **no cookies, no bearer token.** The single load-bearing
  secret is the per-council `x-client` code. A wrong code → HTTP 401 (the adapter
  classifies this as `BLOCKED`).

### Verdict:

- Replay outside the browser? **YES** — clean header-only JSON API.
- Effort: **Small** (already built).
- Coverage: **~9 councils** on this platform.

---

## SALESFORCE (Arcus BE / Salesforce Communities)

Test application: **Haringey** public register
`https://publicregister.haringey.gov.uk/pr/s/planning-application/{recordId}`

### Network calls on "Documents" click:  `VERIFIED-CODE` (`src/adapters/salesforce.js`)

1. **POST** `{origin}/pr/s/sfsites/aura?r=1&aura.ApexAction.execute=1`
   - Headers (essential):
     - `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`
     - `Origin: {origin}` , `Referer: {origin}/pr/s/planning-application/{recordId}`
     - `Accept: */*`
   - Body (form-urlencoded), three fields:
     - `message` = JSON: ApexAction `aura://ApexActionController/ACTION$execute`
       with `params: { namespace:"arcuscommunity", classname:"PR_FilesListCont",
       method:"getFiles", params:{ recordId, registerName:null }, cacheable:true }`
     - `aura.context` = JSON: `{ mode:"PROD", fwuid:"{PER-COUNCIL FWUID}",
       app:"siteforce:communityApp", … }`
     - `aura.token` = `null`  (no CSRF token required for the guest register)
   - Response Content-Type: `application/json`
   - Response shape:
     ```
     actions[0].returnValue.returnValue = [
       { Id, Title, Description, FileExtension, ContentSize,
         arcshared__Document_Date__c, CreatedDate }, … ]
     ```

### Document download mechanism:

- **Separate session-bound URL per document:**
  **GET** `{origin}/pr/sfc/servlet.shepherd/version/download/{Id}`
  — served to the **same guest session** the Aura POST ran under (carries the
  session cookies the context picked up).

### Auth/session requirements:

- **Guest session cookies** (set implicitly by the Aura POST) — these are the
  load-bearing piece for the download, not a header.
- **Per-council `fwuid`** (changes when the council's Salesforce org is upgraded)
  and **per-council `namespace`/`classname`** (Haringey = `arcuscommunity` /
  `PR_FilesListCont`; Wiltshire rejected that class → needs its own captured config).

### Verdict:

- Replay outside the browser? **YES, with caveats** — the Aura call replays, but
  `fwuid` and the Apex class are per-council and drift over time; downloads are
  session-bound.
- Effort: **Medium** (built, but each new council needs one live Aura capture).
- Coverage: **~1 confirmed (Haringey)** today; expandable per-council with capture.

---

## SOCRATA

Test application source: **Camden Planning Applications** dataset
`https://opendata.camden.gov.uk/resource/2eiu-s2cw.json`

### Network calls:  `LIVE-PROBE`

1. **GET** `https://opendata.camden.gov.uk/api/catalog/v1?q=planning` → dataset
   discovery (returns the dataset `id` `2eiu-s2cw`, column list, etc.).
2. **GET** `https://opendata.camden.gov.uk/resource/2eiu-s2cw.json?$limit=…`
   - Headers: `Accept: application/json` (public SODA2 API; an app token only
     affects rate limits).
   - Response Content-Type: `application/json`
   - Response shape: array of application **metadata** rows, e.g.:
     ```json
     { "application_number":"2010/0844/L", "development_address":"…",
       "development_description":"…", "decision_type":"Granted",
       "registered_date":"…", "decision_date":"…", "case_officer":"…",
       "applicant_name":"…", "latitude":"…", "longitude":"…",
       "full_application": { "url":
         "https://planningrecords.camden.gov.uk/NECSWS/Redirection/redirect.aspx?linkid=EXDC&PARAM0=213154" } }
     ```

### Document download mechanism:

- **None on the Socrata platform.** The dataset is tabular metadata only — there
  is no document/file column. The only pointer to documents is
  `full_application.url`, which **redirects to a separate system**
  (`planningrecords.camden.gov.uk/NECSWS/…`, an NEC/Northgate-lineage portal).
  Fetching documents from Camden is therefore a _different platform's_ problem
  (`NEEDS-CAPTURE`, Northgate-family), not Socrata's.

### Auth/session requirements:

- None for the metadata API.

### Verdict:

- Replay outside the browser? **YES for metadata; N/A for documents** (there are none).
- Effort: **Small** for a metadata client — but note this **overlaps what Planit
  already gives us.** Socrata's incremental value for the _documents_ mission is ~0.
- Coverage: **metadata only.** Honest implication: the detector currently routes
  `socrata` → generic, which will _always_ find 0 documents on the Socrata host
  because none exist there. Socrata should be treated as a metadata source, not a
  document source.

---

## NORTHGATE (Planning Explorer)

Test application: **Wandsworth 2024/4298** (Peabody Estate, St John's Hill — approved 28/03/2025, has documents)
Detail page (`PARAM0` = internal id `1174186`):
`https://planning.wandsworth.gov.uk/Northgate/PlanningExplorer/Generic/StdDetails.aspx?…PARAM0=1174186&XSLT=…/PLDetails.xslt…`

### Network calls on "Documents" click:  `LIVE-PROBE` + `NEEDS-CAPTURE`

1. **GET** the `StdDetails.aspx` detail page → `LIVE-PROBE`
   - Server-rendered HTML (~26 KB). **Contains no documents.** Its tabs (separate
     `XSLT=` views) are Dates / Meetings / Constraints / Site History / Consultees —
     there is **no Documents tab in this skin's menu** (`PL.xml` confirmed).
   - The only route to documents is a **footer anchor** to a _different host_:
     ```
     https://planning2.wandsworth.gov.uk/planningcase/comments.aspx?case=2024/4298
     ```
     **Two-ID problem:** the detail page is keyed by internal `PARAM0` (1174186),
     but the documents subsystem is keyed by the **human application reference**
     (`2024/4298`). An adapter needs the reference (Planit supplies it).

2. **GET** `https://planning2.wandsworth.gov.uk/planningcase/comments.aspx?case={REF}` → `LIVE-PROBE`
   - Server-rendered ASP.NET shell (~31 KB) — `__doPostBack` present, plus an
     **AngularJS `ng-app`** marker.
   - The HTML contains the document-list **scaffolding only** — the visible strings
     `"List documents"`, `"Document type"`, `"Number of documents"` — but **zero
     document rows and zero PDF/file links.** The list is populated **client-side
     (Angular) or via an ASP.NET postback**, neither of which a raw GET reveals.
   - The page's only script is a bundled `WebResource.axd`; no API base, service
     URL, `.json`, `.asmx`/`.svc`/`.ashx` endpoint is exposed in the served HTML.

3. **The actual document-list request and the per-document download URL:** `NEEDS-CAPTURE`
   - Method, URL pattern, request body (likely an ASP.NET `__VIEWSTATE`/`__doPostBack`
     form POST **or** an Angular XHR to a backend service), response shape, and the
     download URL/token are **not observable via `curl`** and are **not guessed here.**

### Document download mechanism:

- `NEEDS-CAPTURE`. Unknown whether downloads are direct URLs, tokenised, or
  session-bound until the population request is captured in a real browser.

### Auth/session requirements:

- `NEEDS-CAPTURE`. The `comments.aspx` GET returned the shell without cookies, but
  the population/download calls may require `__VIEWSTATE` continuity or a session
  cookie — unconfirmed.

### Verdict:

- Replay outside the browser? **UNKNOWN** — cannot be confirmed without capturing
  the JS/postback traffic. (This is exactly the blind spot the API-tap strategy
  exists to solve, and exactly where it's hardest.)
- Effort: **Unknown until captured;** plausibly Medium–Large, and the documents
  subsystem **varies per council** (Wandsworth = `planning2.wandsworth/planningcase`;
  Birmingham and others run their own — each needs its own capture).
- Coverage if a clean call exists: **~12 councils.**

---

## Tascomi / CivicaJSON / Atrium (bonus)

**Not investigated this pass.** No live probe was performed and no DevTools
capture exists, so — per the no-guessing rule — there is nothing factual to report
yet. Queued for the capture pass below.

---

## What only a real DevTools/HAR capture can fill (checklist)

For each `NEEDS-CAPTURE` item, please capture and paste (HAR export is ideal):

**Northgate — Wandsworth 2024/4298 (and one Birmingham app):**
1. Open `https://planning2.wandsworth.gov.uk/planningcase/comments.aspx?case=2024/4298`.
2. DevTools → Network → **Fetch/XHR** filter, then **Preserve log** on. Reload.
3. For the request that returns the document **list**, capture:
   - Method + full URL (note query/body that carries `2024/4298` or `1174186`).
   - Request headers (esp. any `X-*`, `Content-Type`, cookies).
   - Request body verbatim (if POST — likely `__VIEWSTATE`/`__EVENTTARGET` or JSON).
   - Response `Content-Type` + the first ~30 lines of the response body.
4. Click one document to download; capture that request's URL, headers, and whether
   it 200s when replayed in a fresh tab (tells us if it's session-bound or direct).

**Bonus platforms:** one validated, document-bearing application each for Tascomi,
Civica, Atrium — same four steps.

With those captures, the `NEEDS-CAPTURE` rows convert to `VERIFIED-CODE`-grade
evidence and Phase 2 can size the Northgate adapter honestly.

---

## Phase 1 bottom line

- **Tractable today (clean replayable transport, evidence-backed):** Idox (HTML,
  direct PDFs), Arcus (header JSON API), Salesforce (Aura POST, with per-council
  capture). These three already exist and are proven.
- **Metadata, not documents:** Socrata — useful as a Planit-like feed, but it has
  **no documents**; do not expect the document mission to gain from it.
- **The real frontier:** Northgate documents are **JS/postback-gated in a separate
  subsystem** and could not be confirmed by HTTP probe — this is the one platform
  whose adapter genuinely depends on a browser capture (or a Phase-4
  `page.on('response')` interceptor) before it can be designed.
