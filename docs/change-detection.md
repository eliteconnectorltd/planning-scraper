# Document change detection (Pattern C)

Cross-cutting capability (applies to **all** adapters — Idox, Arcus, Salesforce,
Capita, Generic): re-check **active** applications for new documents on each run,
and **skip terminal** applications so they aren't re-processed daily.

The adapters are unaware of re-checks — they just scrape and return documents. All
change-detection logic lives in the **orchestrator** ([`src/index.js`](../src/index.js))
and the repositories. Migration: [`007_change_detection.sql`](../supabase/migrations/007_change_detection.sql).

## Terminal status

[`src/utils/terminalStatus.js`](../src/utils/terminalStatus.js) — single source of
truth. `isTerminalStatus(status)` lowercases/trims and exact-matches:

```
decided, refused, granted, permitted, approved, withdrawn,
application withdrawn, decision issued, application permitted,
application refused, application granted, finally disposed of
```

**Unknown / unlisted / null status → ACTIVE** (returns `false`). Re-checking a
finished application wastes a little work; skipping a still-live one would silently
miss documents — so we err toward re-checking.

Used by the orchestrator (decide whether to re-check) and by
`applicationsRepository.mapApplication` (set `applications.is_terminal`).

## Schema (migration 007)

`applications`:
- `last_checked_at` — set **only** when we attempted document extraction
  (terminal-skip, post-scrape, resume re-check). **Not** general "last touched"
  (use `updated_at` for that). Filter/queued/missing_url/generic_disabled upserts
  do **not** stamp it.
- `documents_last_changed_at` — set **only** on a run where the document set changed.
- `is_terminal` — `true` once status is terminal; such apps drop out of daily
  re-checks. Default `false`.
- `recheck_count` — incremented each time we re-encounter the `application_uid`.

`documents`:
- `first_seen_at` — DB default `now()` on INSERT; **never overwritten**
  (`mapDocument` deliberately omits it from the upsert payload, so an update leaves
  it intact).
- `last_seen_at` — bumped to `now()` on **every** upsert, including `skipped_known`
  (a still-present document's observation time advances even when we skip
  re-downloading it).
- `status` — `'active'` for now. This is the document **lifecycle** status, distinct
  from the download status (which lives in `extraction_status`). `'removed'`
  detection is Phase 5.

## `mapApplication(app, opts)` — conditional columns

Three change-detection columns break the "emit every column" rule so a thin
status-only upsert can't clobber them. Each is included **only** when signalled:

| column | included when |
|---|---|
| `last_checked_at` | `opts.lastChecked === true` |
| `is_terminal` | `app.status` is set **and** `isTerminalStatus(app.status)` (only ever emits `true`) |
| `documents_last_changed_at` | `opts.documentsChanged === true` |
| `recheck_count` | `typeof opts.recheckCount === 'number'` |

`is_terminal` is never emitted as `false`, so a thin upsert can't flip a terminal
app back to active. (A genuine terminal→reopened transition is **not** auto-unflagged
— rare; manual fix. Documented limitation.)

Call sites and their opts:
- terminal-skip upsert → `{ lastChecked, recheckCount }`
- queued / skipped_resume upsert → `{ recheckCount }`
- post-scrape upsert → `{ lastChecked, documentsChanged, recheckCount }`
- skipped_filter / missing_url / generic_disabled / initial batch → **no opts**
  (these are not extraction attempts).

## Orchestrator loop order

1. Postcode filter (unchanged).
2. **Read existing row** (`findByUid`, one round-trip):
   - `existing.is_terminal === true` **AND** `existing.recheck_count > 0` → upsert
     `scrape_status='skipped_terminal'` with `{lastChecked, recheckCount}`, log,
     `continue`. **Not** processed, **not** counted as a failure. The
     `recheck_count > 0` guard means we only skip a terminal application we have
     **already scraped at least once** — a first encounter is always scraped (see
     below).
   - otherwise (active, OR terminal-but-never-scraped, OR not found) →
     `recheckCount = (existing?.recheck_count||0)+1`; fetch `knownUrls` =
     `documents.source_url` for this app (one round-trip; empty when not found).
3. Status upsert (`queued`/`skipped_resume`) with `{recheckCount}`.
4. Resume fast-path — now **after** the terminal check; its downloads receive
   `knownUrls` too.
5. Detect/route (+ Capita override).
6. Adapter invocation.
7. Download loop — `downloadDocument(..., knownUrls)`.
8. **Change detection:** `documentsChanged = newUrls>0 || missingUrls>0`, where
   `newUrls = adapterUrls − knownUrls` and `missingUrls = knownUrls − adapterUrls`.
   Logged as counts only: `[change] {uid}: +{new} -{missing}`.
9. Post-scrape upsert with `{lastChecked, documentsChanged, recheckCount}`.

Two extra DB round-trips per application (`findByUid`, `listDocuments`) — accepted.

## Cross-run document skip (`knownUrls`)

`downloadDocument(doc, application, council, manifest, context, downloadAuth,
extractionMethod, knownUrls)` — the trailing `knownUrls` Set holds source URLs
already in the DB. If `doc.url` is in it, the download is skipped:
- status `skipped_known` (counted as `downloadsSkippedKnown` in the run summary;
  neither completed, failed, nor a duplicate);
- the `finally` block still upserts the existing document row so `last_seen_at`
  advances (the doc is still present). The `skipped_known` `resultRecord` carries
  `sourceUrl=doc.url`, which with the resolved `application_id` is exactly the
  `(application_id, source_url)` upsert conflict key, so the bump lands on the right
  row without any re-fetch.

The intra-run SHA-256 dedup still runs on everything **not** skipped by `knownUrls`.

### Known limitation (DECISION 1)
`knownUrls` keys on **URL**. If a council replaces a document's **content** at the
**same URL** (e.g. a corrected PDF), the skip misses it. Phase 5 adds a periodic
full re-download to catch this.

## Historical-data caveat (migration 007 backfill)

Migration 007 adds `first_seen_at` and `last_seen_at` to **existing** documents with
a default of the **migration timestamp**. Documents that existed before the
migration will all show `first_seen_at = [migration date]`, regardless of when they
were actually first inserted. Dashboard queries filtering on `first_seen_at` will be
**inaccurate for pre-migration documents**. Data from post-migration runs onwards is
accurate. (Same applies to `last_seen_at` until each document is next observed by a
run, after which it reflects the real observation time.)

The `first_seen_at`-preservation mechanism was verified empirically: Supabase
`upsert` with `onConflict` leaves columns **absent from the payload** untouched on
update (proven against an existing column, since the new columns require the
migration first). `mapDocument` deliberately omits `first_seen_at` from its payload,
so once the DB default sets it on INSERT it is never overwritten on subsequent
re-checks. See `docs/era-testing-results.md` for the test output.

## Scrape-every-application-once (first-encounter rule)

**Pattern C scrapes every application at least once — even one whose status is
already terminal.** The terminal skip only fires for an application we have
*already* scraped (`is_terminal = true` **AND** `recheck_count > 0`).

Why this matters: applications surfaced for the first time (especially by a
date-range backfill of older data) are frequently already decided
(`status = "FINAL DECISION"`). The earlier gate skipped them on first encounter, so
their documents — which exist on the portal — were never fetched. The
`recheck_count > 0` guard fixes this:

- **First encounter** (`recheck_count = 0`, even if status is terminal) → run the
  adapter, fetch documents. `mapApplication` then sets `is_terminal` from the live
  status and the post-scrape upsert sets `recheck_count = 1`.
- **Subsequent encounters** (`recheck_count >= 1`) of a terminal application →
  `skipped_terminal`, as before. Daily re-runs stay cheap.

`recheck_count = 0` with `is_terminal = true` is also the signature of the earlier
first-encounter-skip bug (the flag was set from Planit status without ever
scraping); we deliberately don't trust it. Migration
`009_pattern_c_first_run_fix.sql` resets those stuck rows
(`is_terminal = true AND recheck_count = 0 → false / 0`) so the next run scrapes
them once. It only touches never-scraped rows; genuinely-finished applications
(`recheck_count >= 1`) keep their terminal flag.

## First-run behavior (post-migration)

- All existing rows start `is_terminal=false` → every app is re-checked once on the
  first post-migration run. Terminal apps flip to `true` after that and drop out of
  daily re-checks.
- Initial runs are slightly **more expensive** than before this fix: first-time
  *terminal* applications are now scraped once (previously skipped). This is the
  point — it's the only way their documents get fetched. After that first scrape
  they carry `recheck_count >= 1` and are skipped on every subsequent run.
- That first run is expensive in **adapter navigations** (visits every active app
  plus each first-time terminal app once) but **cheap in downloads**: `knownUrls` is
  populated from the DB, so documents already persisted from earlier runs are **not**
  re-downloaded. Acceptable.

## Status enum (current, full)

Existing: `scraped`, `queued`, `skipped_resume`, `skipped_filter`, `failed`,
`blocked`, `generic_disabled`, `generic_scraped`, `blocked_anti_bot`,
`portal_unreachable`, `timeout`, `requires_auth`, `requires_different_path`,
`missing_url`, `unknown`.

New in Phase 3: **`skipped_terminal`** (is_terminal=true, re-check skipped),
**`no_documents`** (page reached, empty document set — Capita; meaningfully distinct
from a `scraped` row with zero docs).

## Phase 5 (deferred — not built)

- Adaptive re-check frequency (unchanged 30+ days → weekly).
- Periodic full re-download (catches same-URL content swaps `knownUrls` misses).
- Removed-document detection (`documents.status='removed'` for `missingUrls`;
  currently logged only).
- List-only adapter mode (cheaper change detection — IDs only, skip full scrape).
- Capita contact-fields secondary fetch from the Northgate detail page.
- Auto-defer Northgate-detail-only councils from generic to capita using generic's
  `crossDomainDocLinks` telemetry.
