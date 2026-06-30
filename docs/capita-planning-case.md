# Capita Planning Case adapter

HTTP-only adapter for the **Capita "Planning Case" documents subsystem** behind
many Northgate Planning-Explorer councils (Wandsworth verified). The Northgate
`planning.{council}` host is the search/detail front-end; documents live on a
separate `planning2.{council}/planningcase/` + `/IAM/` Capita store.

- Module: [`src/adapters/capita-planning-case.js`](../src/adapters/capita-planning-case.js) → `scrapeCapitaDocuments(application, navUrl)`
- **First no-Playwright adapter.** Pure Node `fetch` + a tiny manual cookie jar.
  No `browser`, no `context`. `capita` is **not** in `BROWSER_PLATFORMS`, so the
  shared downloadManager runs with `context=null`.
- Routing: [`src/detector.js`](../src/detector.js) `routeAdapter()` returns `capita`
  when a URL contains `planningcase/comments.aspx`. `detectPlatform()` is unchanged
  (returns `northgate`/`unknown`), so `applications.platform` stays truthful.

## What it does

1. **Resolve the comments URL.** If `navUrl` already contains
   `planningcase/comments.aspx`, use it (the `?case={ref}` is baked in). Otherwise
   GET the Northgate detail page and extract the footer
   `…/planningcase/comments.aspx?case=…` anchor. If absent →
   `scrapeStatusHint='requires_different_path'` (clean, not a crash).
2. **GET `comments.aspx`** (cookie jar captures `ASP.NET_SessionId`). Parse
   `lblAddress / lblCaseNo / lblStatus / lblDevDesc` and the hidden
   `__VIEWSTATE / __VIEWSTATEGENERATOR / __EVENTVALIDATION`.
3. **`__doPostBack` loop** over each document category, threading the freshest
   VIEWSTATE/EVENTVALIDATION forward sequentially (exactly as a browser would).
   The `gvResults` table is empty until a category postback fires, so **every**
   category is requested (there are no inline initial-render documents on
   Wandsworth). Docs are tagged with the category they came from.
4. **Build document records** — one per `docid`, URL per the chosen strategy below,
   `confidence:'HIGH'`. Returns them; **the orchestrator downloads** via the shared
   downloadManager (`extraction_method='capita-planning-case'`).

### Per-row metadata parsing (verified on 2024/0307 — 97 docs, 5 categories)

The category table (`gvDocs`, present in the initial HTML) and the per-category
results table (`gvResults`, rendered per postback) are parsed by:

- `parseCategoryRows(html)` → `[{ target, label, count }]`. `label` from
  `gvDocs_lblChoice_{i}` (e.g. "Application Form", "Drawing", "Report"); `count`
  from `gvDocs_Label2_{i}`; `target` from the row's `__doPostBack('gvDocs$ctlNN$lnkDShow','')`,
  zipped with the labels **by index** (no control-id-numbering assumption).
- `parseDocRows(html)` → `[{ docid, date, description }]`, walking each `<tr>` in the
  `gvResults` table:
  - `gvResults_Label1_{r}` → **date** (e.g. "30 Jan 2024"; normalized to
    `2024-01-30` on persist by `documentsRepository.normalizeDate`).
  - `gvResults_Label2_{r}` → **description** (e.g. "EXISTING TREE STRATEGY PLAN";
    **empty → `null`**, e.g. Application Form rows).
  - anchor `docid` (IAMLink/IAMCache); header row (no docid) skipped; deduped by docid.

Each document record then carries:
- `type` = the category label of the postback that produced it (e.g. "Drawing").
- `description` = the row description (or `null`).
- `date` = the row date.
- `name` = the description when present, else `"{type} {docid}"` (e.g.
  `"Application Form 5854005"`) so two docs in one application never share a name.

`description` is persisted to `documents.description` (migration 008); `type` →
`document_type`, `date` → `document_date`, `name` → `document_name`.

> `parseDocIds()` (anchor-text only) is retained/exported for compatibility but is
> no longer used by `scrapeCapitaDocuments` — `parseDocRows()` replaces it.

## Orchestrator routing (string-only, no per-council code)

`routeAdapter()` sees a single URL. The orchestrator detects/routes on `sourceUrl`
(the Northgate **detail** page), so it adds one extra check: if the app would route
to `generic` **and** the `planningcase/comments.aspx` string appears in either
`sourceUrl` or `docsUrl`, it upgrades the route to `capita` and navigates the
comments URL directly. This is string-matching only — **no council names anywhere.**
Idox/Arcus/Salesforce routing is untouched (the upgrade only ever replaces a
would-be `generic`).

## Statuses written to `applications.scrape_status`

| status | meaning |
|---|---|
| `scraped` | reached the comments page and parsed metadata and/or ≥1 document |
| `no_documents` | page reached and parsed, but the documents table was empty |
| `requires_different_path` | not a Capita URL, or no comments link (older/pre-Capita era) |
| `portal_unreachable` | network/DNS/HTTP ≥400 |
| `timeout` | request exceeded `CAPITA_TIMEOUT_MS` |
| `blocked_anti_bot` | Cloudflare/CAPTCHA marker detected (detect-and-record only) |

`metrics.partial=true` (kept on a `scraped` row) flags that one or more category
postbacks failed and the document set may be incomplete — we return what we got
rather than failing the whole application.

## Configuration (env)

| var | default | effect |
|---|---|---|
| `CAPITA_DOC_URL_STRATEGY` | `iamlink` | download URL form (see below) |
| `CAPITA_TIMEOUT_MS` | `30000` | per-request timeout |
| `CAPITA_MAX_POSTBACKS` | `25` | safety bound on category postbacks per app |

## URL strategy (⚠️ pending Phase 3c verification)

Two candidate download URL forms for a `docid`:
- `iamlink` — `https://{host}/IAM/IAMLink.aspx?docid={id}` (type-agnostic redirector)
- `iamcache` — `https://{host}/iam/IAMCache/{id}/{id}.pdf` (direct file; PDF-only)

**Default is `iamlink`** on the design hypothesis that the redirector is stateless
and returns the correct content-type for non-PDF categories (Plans/Drawings →
TIFF/DWG). This MUST be verified before relying on it — see
[`era-testing-results.md`](era-testing-results.md) for the test matrix. If `iamlink`
turns out to be session-bound or returns HTML, switch to `iamcache` via
`CAPITA_DOC_URL_STRATEGY=iamcache` and accept the PDF-extension caveat (non-PDF
categories may 404 or mislabel).

## Honest limits

- **Contact fields** (applicant/agent/case_officer) are **not** on the comments page
  (they live on the Northgate detail page, a different host) → returned `null`.
  Planit already supplies much of this. A secondary detail-page fetch is Phase 5.
- **Northgate-detail-only councils** whose comments link is *not* in Planit's
  `source_url`/`docs_url` fall to `generic` for the first ship. Generic records the
  cross-domain `planningcase` link (`crossDomainDocLinks`) as telemetry for a future
  auto-defer (Phase 5). No council-specific routing is added now.
- **gvDocs / gvResults / `__doPostBack` parsing is regex-based** and verified against
  the Wandsworth capture. Control-id assumptions (e.g. category targets contain
  `gvDocs`) are flagged inline in the adapter and must be re-checked when a new
  council is onboarded — if a council needs different selectors, that's a signal it
  may need its own adapter, not a special-case here.
- **`__VIEWSTATE` continuity**: a stale-state postback rejection downgrades to
  `partial` (return what we have) rather than failing.
- **Wandsworth-only verified.** Birmingham + other Northgate councils are unverified
  (Birmingham capture is parallel manual work, out of this phase).

## Change detection

Capita participates in Pattern C ([`change-detection.md`](change-detection.md)) with
zero Capita-specific code: terminal applications are skipped, `knownUrls` cross-run
dedup is applied by the orchestrator's download loop, and document-set changes are
detected by URL diff. See that doc for semantics.

## Privacy

Personal data is never logged. Logs carry council + ref + counts (doc count,
category count) only.
