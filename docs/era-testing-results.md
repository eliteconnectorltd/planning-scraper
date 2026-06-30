# Capita adapter — Phase 3c test results

All tests run 2026-06-29 against **live Wandsworth** (`planning2.wandsworth.gov.uk`)
from the dev machine. Targeted single applications only — no full pipeline run.
Discovery (HTTP) is reproducible from any IP; downloads were verified too.

## 1. End-to-end discovery — Wandsworth 2024/4485

`scrapeCapitaDocuments({title:'Wandsworth/2024/4485'}, comments.aspx?case=2024/4485)`:

```
[capita] Wandsworth 2024/4485: docs=3 categories=2 partial=false strategy=iamlink
scrapeStatusHint: null
metrics : {"totalRows":3,"validDocs":3,"runtimeMs":2046,"success":true,"partial":false}
metadata: address="Battersea Power Station Phase 6 Cringle Street SW11 8BX"
          case_no="2024/4485" status="Registered"
          dev_description="Submission of details pursuant to condition 18 ..."
          applicant_name=null agent_name=null case_officer=null   (not on comments page — expected)
documents: 3
  https://planning2.wandsworth.gov.uk/IAM/IAMLink.aspx?docid=5984457
  https://planning2.wandsworth.gov.uk/IAM/IAMLink.aspx?docid=5984459
  https://planning2.wandsworth.gov.uk/IAM/IAMLink.aspx?docid=5984458
```

**Result: PASS.** Metadata + 3 documents via 2 category postbacks. ~2s.

### Correction to the Phase 2 roadmap assumption
The roadmap (`platform-adapter-roadmap.md` §0) claimed document ids live in the
**initial server HTML**. Verified FALSE for a plain GET: the initial
`comments.aspx` HTML contains metadata, hidden VIEWSTATE, and the `gvDocs` category
**show** links, but **no `gvResults` / IAM / docid** until a category `__doPostBack`
is fired. The adapter's postback loop is therefore required (it works). Also, the
`__doPostBack(...)` calls are **HTML-entity-encoded** (`&#39;`) in the href — the
parser decodes these before matching (fixed in 3c).

## 2. URL strategy verification

Stateless probe (fresh, no cookies) of both forms for real docids 5984457/8/9:

| docid | `IAMLink.aspx?docid=` | `iam/IAMCache/{id}/{id}.pdf` |
|---|---|---|
| 5984457 | 302 → `/iam/IAMCache/5984457/5984457.pdf` | 200 application/pdf, 462076 B |
| 5984458 | 302 (same pattern) | 200 application/pdf, 259013 B |
| 5984459 | 302 (same pattern) | 200 application/pdf, 235556 B |

Following the IAMLink 302 (`curl -L`) lands on the IAMCache PDF: final
`200 application/pdf 462076`. **Both forms are stateless and public** (no session).

**Decision: keep default `CAPITA_DOC_URL_STRATEGY=iamlink`.** The 302 target path is
**server-constructed**, so for a non-PDF category the server should redirect to the
correct extension — safer than our hardcoded `{id}.pdf` in `iamcache` mode. The
download manager follows redirects, so the extra hop is transparent.

### Non-PDF verification (follow-up item 3) — RESOLVED

`2023/4015` (106 documents, major Battersea development) was used to find non-PDF
documents. Across all 106 docs, the IAMLink 302 target extensions were:

```
{ "pdf": 104, "docx": 1, "(none)": 1 }
```

For the non-PDF document (`docid=5882993`, a `.docx`):

| URL | result |
|---|---|
| `IAMLink.aspx?docid=5882993` (follow) | **200**, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, final `…/5882993.docx` |
| `iam/IAMCache/5882993/5882993.pdf` (hardcoded `.pdf`) | **404** text/html |
| `iam/IAMCache/5882993/5882993.docx` (correct ext) | 200, correct content-type |

**Conclusion: `iamlink` is type-agnostic and is the correct default.** The server
issues the 302 to the file's *real* extension (`.docx` here), so IAMLink works for
PDF and non-PDF alike. The `iamcache` strategy (hardcoded `{id}.pdf`) **404s** on the
`.docx` — confirming it is PDF-only and must not be the default. The bucket's
`allowedMimeTypes` already includes the docx mime, so Storage upload accepts it.

Two honest notes:
- **One document (`docid=5818612`) returned HTTP 500** from IAMLink — a server-side
  broken document. The adapter still *discovers* it (it's in `gvResults`); the
  download would fail with `HTTP Error: 500` and be recorded as a failed document,
  which is correct/honest — one bad doc doesn't fail the application.
- **Filename-extension cosmetic mismatch:** IAMLink URLs have no extension
  (`?docid=N`), so the download manager defaults the stored *filename* to `.pdf`
  (downloadManager L351). A `.docx` is therefore stored under a `…​.pdf` filename even
  though its bytes and `mime_type`/`storage_mime_type` are correct. Cosmetic only;
  fixing it means deriving the filename ext from the final response content-type in
  downloadManager — flagged as a follow-up, out of this phase's scope.

## 3. Era testing — 2018 → 2024

`scrapeCapitaDocuments` against one ref per year:

| ref | hint | docs | status | address (truncated) |
|---|---|---|---|---|
| 2018/0500 | null | 4 | Final Decision | 121 Replingham Road SW18 5LX |
| 2019/2000 | null | 8 | Withdrawn | 24 Khyber Road SW11 2PZ |
| 2020/3000 | null | 5 | Final Decision | 133 Ramsden Road SW12 8RF |
| 2021/4000 | null | 3 | Final Decision | 65 Magdalen Road SW18 3NE |
| 2022/3000 | null | 14 | Final Decision | 25 Octavia Street SW11 3DN |
| 2023/4015 | null | 106 | Final Decision | Phase 6: Battersea Power Station |
| 2024/4485 | null | 3 | Registered | Battersea Power Station Phase 6 |

**Result: PASS across all 7 years.** No pre-Capita era boundary found back to 2018;
every application returned metadata and ≥3 documents. (The `requires_different_path`
path is still exercised structurally — it triggers when no comments link exists —
but no tested Wandsworth era hit it.)

### ⚠️ Terminal-status finding (affects Pattern C)
Wandsworth reports decided applications as **"Final Decision"** and live ones as
**"Registered"**. `"Final Decision"` was **NOT** in the approved `TERMINAL_STATUSES`
list. Left unchanged, decided Wandsworth apps would never get `is_terminal=true` and
would be re-checked daily forever — defeating Pattern C for the verified council.
**Action taken in 3c:** added `'final decision'` to
[`terminalStatus.js`](../src/utils/terminalStatus.js) with an evidence comment.
`"Withdrawn"` was already terminal; `"Registered"` correctly stays active.
**Flagged for your review** — confirm or revert. Other councils may use other
wordings; expand the list as captures arrive.

## 4. downloadManager smoke test (context=null, downloadAuth=undefined)

`downloadDocument({url: IAMCache 5984457 pdf}, app, 'Wandsworth', {files:[]}, null,
undefined, 'capita-planning-case')`:

```
[download] No session context provided. Launching isolated browser...
[download] Detected attachment download event.
[download] Uploaded to Storage (451.2 KB) at Wandsworth/.../capita-smoke.pdf
status            : downloaded
sizeBytes         : 462076          (matches the curl probe exactly)
mimeType          : application/pdf
sha256            : f6b71f1de504819f...
extraction_method : capita-planning-case
error             : null
```

**Result: PASS.** A non-browser adapter's public document downloads correctly
through the shared manager with `context=null`. (Supabase env was live, so the test
object was uploaded and then **deleted** as cleanup — no smoke-test artifact left in
the bucket.)

## Summary

| Test | Result |
|---|---|
| E2E discovery (2024/4485) | ✅ 3 docs + metadata, ~2s |
| URL strategy (PDF) | ✅ both stateless; `iamlink` chosen |
| URL strategy (non-PDF) | ✅ `.docx` via IAMLink 200 + correct type; `iamcache` .pdf 404s (verified on 2023/4015) |
| Era 2018–2024 | ✅ all 7 years resolve with docs |
| Terminal status | ⚠️ added `'final decision'` (needs sign-off) |
| downloadManager smoke (context=null) | ✅ downloaded, bytes match |

Not yet tested (needs the UK VM / full pipeline): a complete `npm start` run with
DB writes, change-detection across two consecutive runs (knownUrls skip + `[change]`
counts), and a second non-Wandsworth Capita council (Birmingham — parallel manual
work, out of scope here).
