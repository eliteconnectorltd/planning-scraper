# Platform Adapter Roadmap (Phase 2 — design only)

Evidence base: `docs/platform-network-analysis.md` (Phase 1) + the Wandsworth
DevTools capture (2024/4298). **No implementation here** — design and honest
estimates only, for review before Phase 3.

---

## 0. Headline conclusions

1. **Northgate documents are HTTP-replayable — no browser, no network interception.**
   The Wandsworth capture shows the document IDs live in the **server HTML** of the
   Capita "Planning Case" comments page (initial GET + `__doPostBack` re-renders),
   and the files are **direct public stateless URLs**. This kills the Phase-4
   interception stretch goal for this platform — it isn't needed.
2. **The two-ID mismatch (PARAM0 vs ref) is resolved by link-extraction, not transform.**
   The Northgate detail page's footer anchor already contains the comments URL with
   the human ref baked in (`…/planningcase/comments.aspx?case=2024/4298`). We read
   the link; we don't reconstruct it. Planit also carries the ref independently.
3. **The documents back-end is Capita, not Northgate.** `planning.{council}/Northgate/…`
   is the search/detail front-end; `planning2.{council}/planningcase/` + `/iam/` is a
   separate **Capita Planning Case + IAM document store**. Naming should reflect the
   thing we actually talk to (the Capita subsystem), because non-Northgate councils
   could in principle use Capita too, and some Northgate councils may not.

---

## 1. Tractability verdict per platform

| Platform | Documents transport | Tractable HTTP replay? | Browser needed? |
|----------|--------------------|------------------------|-----------------|
| Idox | Server HTML, direct `/files/…pdf` | **Yes** (proven by curl) | Only for Cloudflare-fronted councils (fallback) |
| Arcus | Header JSON API | **Yes** (built) | No |
| Salesforce | Aura POST, session download | **Yes, with per-council capture** (built) | No (uses context for guest cookies) |
| **Capita Planning Case** | Server HTML + `__doPostBack`, direct `/iam/IAMCache/` files | **Yes** (proven by capture) | **No** |
| Socrata | Public SODA REST | **Yes — metadata only** | No |
| Tascomi / Civica / Atrium | Unknown | Needs capture | Unknown |

**Genuinely need browser rendering:** only the long tail of `unknown` councils
(→ `generic.js`) and Cloudflare-challenged Idox councils. Nothing investigated so
far requires a JS-execution engine to *read documents*.

---

## 2. Primary new adapter: `capita-planning-case`

### 2a. Naming

- **`extraction_method` / adapter name: `capita-planning-case`.** Accurate (matches
  the `/planningcase/` path and the Capita IAM store), and not falsely tied to
  "Northgate" (which is only the front-end).
- **`detectPlatform()` still returns `northgate`** for the Planning Explorer host, so
  `applications.platform` stays truthful. **`routeAdapter()` returns `capita`** when
  the Capita docs path is in play. This mirrors the existing detect-vs-route split.

### 2b. Detection (simple URL pattern, per the detector.js convention)

Route to `capita` when **either**:
- the URL contains `planningcase/comments.aspx`  (we already have the docs URL), **or**
- the source host is a Northgate `planning.` host **and** the resolved documents link
  is on a `planning2.` host with `/planningcase/`  (cross-domain Capita comments pattern).

No clever heuristics — string matching only, same as `detector.js` today.

### 2c. Inputs

- `application.title` / a ref field → the human application reference (e.g. `2024/4298`).
- One of: a ready `comments.aspx?case={ref}` URL, **or** the Northgate detail URL
  (from which the adapter extracts the comments link).

### 2d. Flow (pure HTTP client — no Playwright)

```
scrapeCapitaDocuments(application, navUrl) -> { documents, metrics, metadata, scrapeStatusHint }

Step 0  Resolve the comments URL:
        - if navUrl contains 'planningcase/comments.aspx' -> use it
        - else GET the Northgate detail page, extract the footer anchor
          href matching /planningcase/comments\.aspx\?case=/  (the
          "View Associated Application Documents" link). If absent ->
          scrapeStatusHint='requires_different_path', return empty.

Step 1  GET comments.aspx?case={ref}
        - keep the Set-Cookie (ASP.NET_SessionId) in an adapter-local jar
          for the postbacks in Step 2.
        - parse from the HTML:
            * metadata spans: lblAddress, lblCaseNo, lblStatus, lblDevDesc
            * gvDocs table -> document CATEGORIES + per-category count +
              each category's postback target (e.g. gvDocs$ctl03$lnkDShow)
            * gvResults table -> doc links for the CURRENTLY shown category:
                <a href="…/IAM/IAMLink.aspx?docid={ID}">  -> capture {ID}
        - extract hidden fields: __VIEWSTATE, __VIEWSTATEGENERATOR,
          __EVENTVALIDATION.

Step 2  For each category NOT already shown (count>0 and not in gvResults):
        POST comments.aspx?case={ref}   (same cookie jar)
          Content-Type: application/x-www-form-urlencoded
          body: __EVENTTARGET={categoryCtlId} & __EVENTARGUMENT= &
                __VIEWSTATE=… & __VIEWSTATEGENERATOR=… & __EVENTVALIDATION=…
        -> response HTML has gvResults populated for that category.
        Thread the FRESH __VIEWSTATE/__EVENTVALIDATION from each response
        into the next POST (sequential, exactly as a browser would).
        Collect all {docid}.

Step 3  Build document records. Per docid:
            url       = https://{host}/iam/IAMCache/{docid}/{docid}.pdf   (verified stateless/public)
            name/type = the category + link text from gvResults
            confidence= HIGH (direct file URL)
        downloadAuth = undefined  (public, no cookies/headers needed)

Step 4  Return; index.js runs the shared downloadManager loop with
        extraction_method='capita-planning-case', context=null.
```

### 2e. Return shape (matches existing adapter convention)

```
{
  documents: [{ name, type, date, url, confidence:'HIGH' }],
  metrics:   { totalRows, validDocs, runtimeMs, success },
  metadata:  { address, case_no, status, dev_description,
               applicant_name:null, agent_name:null, case_officer:null },
  downloadAuth: undefined,           // public stateless downloads
  scrapeStatusHint: null | 'requires_different_path' | 'portal_unreachable' | 'no_documents'
}
```

### 2f. Honest caveats (carried from your capture + design review)

- **Contact fields (applicant/agent/case_officer) are NOT on the comments page.**
  Only address/case-no/status/description (`lbl*`) are. Those contacts live on the
  Northgate detail page (different host). The adapter records what it can and leaves
  contacts `null`. *Optional enhancement:* a second GET to the Northgate detail page
  to scrape contacts — defer; Planit already supplies much of this.
- **File-extension assumption.** `…/IAMCache/{docid}/{docid}.pdf` is verified for
  PDFs. For non-PDF categories (Plans/Drawings as TIFF/DWG) the `.pdf` suffix may be
  wrong. The HTML's own `IAMLink.aspx?docid={ID}` redirector is type-agnostic and is
  the safer canonical — **Phase 3 must verify whether `IAMLink.aspx?docid=` is also
  stateless**; if yes, prefer it as the download URL and drop the extension guess.
- **`__VIEWSTATE` continuity risk.** WebForms event-validation can reject a postback
  that reuses a stale VIEWSTATE. Mitigation = sequential postbacks threading the
  freshest VIEWSTATE/EVENTVALIDATION (above). If a category postback still fails,
  return the categories we *did* get and mark `metrics.partial=true` rather than
  failing the whole application.
- **Wandsworth-only verified.** Birmingham capture still outstanding — see §6. Until
  then the adapter is honest about scope: it works where the Capita comments pattern
  is present, and cleanly returns `requires_different_path` where it isn't.
- **Older applications** may predate the Capita store → `requires_different_path`
  (not a crash, not silent "unknown").

### 2g. Integration change (new pattern: a non-browser adapter)

- Add `capita` to `routeAdapter()` output; **do not** add it to `BROWSER_PLATFORMS`
  in `index.js`. The adapter runs as a plain async function (no `browser.newContext`),
  and `downloadManager` is already called with `context=null` for non-browser
  adapters. This is the **first no-Playwright adapter** and becomes the template for
  the Idox HTTP refactor (§4).
- HTTP: Node 18+ `fetch` with a tiny manual cookie jar for the GET→postback sequence.

### 2h. Effort & coverage

- **Effort:** ~150–200 lines, **1–2 focused days** incl. tests. (Matches your estimate.)
- **Coverage:**
  - Definitely works: **Wandsworth** (verified).
  - Likely: other councils on Capita Planning Case comments — **~5–8** (unverified estimate).
  - Needs verification: **Birmingham** + other Northgate councils (could be Capita,
    could be a different docs back-end). Birmingham capture is the gate on this claim.

---

## 3. Revised architectural picture

```
                         Planit (metadata for ALL councils — 100% coverage)
                                          │
                        detector.detectPlatform()  (truthful platform label)
                                          │
                        detector.routeAdapter()    (which fetcher runs)
                                          │
   ┌───────────────┬───────────────┬───────────────┬───────────────┬─────────────┐
   │  idox         │  arcus        │  salesforce   │  capita (NEW)  │  socrata(NEW)│
   │  HTML (PW;    │  JSON API     │  Aura POST    │  HTML+postback │  SODA REST   │
   │  HTTP refactor│  (HTTP)       │  (HTTP+cookies)│ (HTTP, no PW) │  metadata-   │
   │  roadmap §4)  │               │               │  direct files │  only        │
   └───────┬───────┴───────────────┴───────────────┴───────────────┴─────────────┘
           │ fallback (Cloudflare-challenged Idox)
           ▼
        browser-based Idox path (retained)
                                          │
                          generic.js  (genuinely unknown councils only)
                                          │
            Phase 4 stretch: page.on('response') interception —
            ONLY for a future JS-gated platform with no server-HTML/API
            (Capita did NOT need it; reserve for Tascomi/Civica/Atrium IF
             a capture later shows pure-XHR with no server HTML).
```

- **Per-platform HTTP/API adapters** (idox, arcus, salesforce, capita, socrata) are
  the primary path.
- **Browser adapters retained for fallback:** Idox browser path for challenged
  councils; `generic.js` for unknowns.
- **`socrata` is rerouted away from `generic`** (see §5) — it has no documents, so
  sending it to a document harvester was a guaranteed failure.
- **Network interception stays a Phase-4 stretch** and currently has **no concrete
  target** — Capita resolved without it.

---

## 4. Roadmap item: Idox Playwright → HTTP-client refactor

**Rationale (from Phase 1):** the Idox documents tab is fully server-rendered with
direct PDF URLs and was reproduced end-to-end by `curl` with no JS. For the majority
of Idox councils, Playwright is pure overhead.

**Design:**
- New `idoxHttp` path: `GET applicationDetails.do?activeTab=documents&keyVal={K}` →
  parse the existing `<table id="Documents">` with the **same row/scoring logic**
  already in `idox.js` (reuse `extractDocumentRows` logic ported to a DOM parser like
  `cheerio`, or a regex over the `/files/…pdf` anchors).
- **Challenge detection gate:** if the response looks like a managed challenge
  (Cloudflare markers, JS-only body, non-200) → **fall back to the existing
  Playwright Idox adapter** for that council. Keep the browser path; don't delete it.
- Behind a flag (`IDOX_HTTP_FIRST=true`) so we can A/B and roll back instantly.

**Payoff:** potential ~10× throughput / cost reduction on the dominant platform
(no browser launch, no page nav, parallelizable HTTP). **No new coverage** — this is
a performance/cost item, not a coverage item.

**Effort:** ~1 day for the HTTP path + fallback wiring + flag; +1 day hardening/A-B
across a sample of councils (some will be challenged and must fall back cleanly).

**Answer to the Phase-1 question "replace the Idox HTML adapter with an API one?":**
No API exists; the HTML *is* the interface. Don't replace — **add an HTTP-client
variant that parses the same HTML**, with the browser adapter retained as the
challenge fallback.

---

## 5. Roadmap item: Socrata → metadata-only client (reroute off generic)

**Rationale (from Phase 1):** Camden's Socrata dataset is pure metadata (no document
column); rows only link out to a *separate* system. Routing `socrata → generic`
guarantees 0 documents and a false "failure".

**Design:**
- New `socrata` adapter = thin SODA client: `GET {host}/resource/{datasetId}.json?…`
  → map rows to application metadata (ref, address, description, decision, dates,
  case_officer, lat/lng). **Returns metadata, `documents: []`,
  `scrapeStatusHint: 'metadata_only'`** — explicitly NOT a failure.
- `routeAdapter()`: `socrata` routes to the `socrata` adapter, **not** `generic`.
- Document acquisition for Socrata councils (e.g. Camden) is a *separate* problem
  handled by whatever underlying platform the council actually uses (Camden's
  `full_application.url` → an NEC/Northgate-lineage system, to be discovered per
  council later). Not in scope for the Socrata client.

**Effort:** ~half a day (dataset-id config per council + a small mapper).
**Coverage:** adds **no document** coverage, but stops guaranteed false failures and
improves metadata correctness. Low effort, worth doing early purely for honesty/signal.

---

## 6. Honest coverage estimate (post-implementation)

| Platform | Councils w/ documents | Success rate (honest) | Notes |
|----------|----------------------|-----------------------|-------|
| Idox | ~104 today → ~200+ reachable | High where not challenged; falls back to browser | HTTP refactor = throughput, not coverage |
| Arcus | ~9 | High | per-council `x-client` |
| Salesforce | ~1 confirmed (Haringey) | Med (per-council `fwuid`/class) | expandable per capture |
| **Capita (new)** | Wandsworth verified; ~5–8 likely | High where pattern present | Birmingham gate |
| Socrata | 0 documents (metadata only) | n/a | reroute fixes false failures |
| generic | long tail | Low | unknowns only |

**Realistic near-term:** documents today ≈ **~115** (Idox+Arcus+Salesforce) →
**~125–135** after Capita (Wandsworth + a few London councils) — a modest *count*
gain but **high value per effort** and it proves the no-Playwright HTTP-adapter
pattern that the Idox refactor then scales. The path to the aspirational
**200–250** runs mainly through **Idox breadth** (already the bulk; the refactor lets
us actually run them all at throughput) plus per-platform captures (Birmingham,
Tascomi/Civica/Atrium) converting `NEEDS-CAPTURE` rows into adapters one at a time.
**Metadata coverage stays ~100% via Planit** regardless.

---

## 7. Implementation order (coverage gain per unit effort)

1. **`capita-planning-case` adapter — FIRST.** Evidence in hand, ~1–2 days, adds new
   document coverage (Wandsworth + likely several councils), and establishes the
   no-Playwright HTTP-adapter template. Highest value/effort.
2. **Socrata metadata client — SECOND (cheap win).** ~½ day, removes guaranteed false
   failures, improves metadata signal. Adds no doc coverage but near-zero cost.
3. **Idox HTTP refactor — THIRD (carefully).** Biggest throughput payoff but touches
   the proven revenue core → must ship behind `IDOX_HTTP_FIRST` with clean browser
   fallback. ~2 days.

**Gate in parallel:** the **Birmingham capture** decides whether Capita is one
adapter (pattern-transform across councils) or needs per-council config — it sizes
Capita's true coverage before we over-claim.

---

## 8. STOP — awaiting review

Pick the platform for Phase 3 (recommended: **`capita-planning-case`**, per §7).
No code until approved.
