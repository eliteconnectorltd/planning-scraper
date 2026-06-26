# Generic Document Harvester

Platform-agnostic Playwright harvester for council portals **not** covered by the
Idox / Arcus / Salesforce adapters. It is the fallback for everything the detector
classifies as `northgate`, `socrata`, or `unknown`.

- Module: [`src/adapters/generic.js`](../src/adapters/generic.js) → `scrapeGenericDocuments(page, application, context)`
- Routing: [`src/detector.js`](../src/detector.js) → `routeAdapter(url)` returns `idox|arcus|salesforce|generic`. `detectPlatform()` is unchanged, so `applications.platform` still records the true platform (e.g. `northgate`).
- Orchestration: [`src/index.js`](../src/index.js) runs it after the SP postcode filter, in the same per-application loop as the other adapters.

## What it does

1. Navigates to the application's `source_url` (30s cap).
2. Detects terminal conditions and records an honest status (no bypass): anti-bot, login wall, timeout, unreachable.
3. Extracts contact fields by label — `applicant`, `agent`, `case_officer` — trying 6 DOM patterns (`th/td`, `dt/dd`, `td/td`, `label/span`, `div.label/div.value`, generic label→adjacent), with a placeholder filter (`PRIVATE`, `Redacted`, `n/a`, `See source`, `Personal Data Removed`, …) → null.
4. Discovers document links (best-effort: clicks a Documents/Plans/… tab if present), collecting `<a href>` ending in `.pdf/.doc(x)/.tif(f)/.jpg/.jpeg/.png/.zip/.dwg/.xls(x)`, deduped by URL.
5. Returns discovered docs + metadata + a discovery confidence. **The orchestrator downloads** via the shared `downloadManager` (SHA-256 dedup, mime normalization, Storage upload, disk fallback) — generic never downloads itself.

Documents are tagged `documents.extraction_method = 'generic'` (migration 006). Contact fields are merged into the application upsert with **adapter priority over Planit** (only the 3 non-null contact keys, so nothing else is clobbered).

## What it CANNOT do (honest limits)

- **Extension-less document handlers** (`getDocument?id=…`, `servlet/…`) — link detection is extension-based, so these are missed → `documentsFound=0`.
- **JS-only document lists** that never render `<a href>` in the DOM.
- **Embedded PDF viewers** with no direct link.
- **Paginated** document lists — only the first page is read.
- **Anti-bot / login walls** — detected and recorded, **never bypassed** (UK CMA risk + IP-ban risk). No retries, no header rotation, no proxy.

Expectation: ~75–85% of councils deliver full automated data over time; the rest provide source links / honest status for case-by-case follow-up. Per-application status is the deliverable, not 100% coverage.

## Statuses written to `applications.scrape_status`

| status | meaning |
|---|---|
| `generic_scraped` | generic ran and extracted ≥1 field or ≥1 document |
| `generic_disabled` | routed to generic but generic not enabled for this council (we chose not to attempt) |
| `blocked_anti_bot` | Cloudflare/CAPTCHA/"verify you are human" marker detected |
| `requires_auth` | login wall detected |
| `timeout` | 30s page load exceeded |
| `portal_unreachable` | DNS/SSL/connection failure |
| `failed` | reached the page but no fields and no documents |

Confidence (logged, not stored): `high` = ≥1 field **and** ≥1 doc downloaded; `medium` = one side only; `low` = docs found but none downloaded; `failed` = neither.

## Configuration (env)

| var | default | effect |
|---|---|---|
| `GENERIC_ENABLED` | `false` | master switch — run generic for **all** non-adapter councils |
| `GENERIC_COUNCILS` | (empty) | comma-separated council names (case-insensitive, matched on `app.area`) to enable generic for, even when `GENERIC_ENABLED=false`. e.g. `Wandsworth,Birmingham` |
| `GENERIC_TIMEOUT_MS` | `30000` | per-page navigation timeout |
| `DISABLE_FIELD_SUPPLEMENT` | `true` | **reserved** — a future "run generic field extraction after a specific adapter to fill missing contacts" pass. **Not wired this ship** (would double navigations for all councils). Documented so the flag name is stable. |

**Generic is opt-in for the first ship** — start with a controlled council subset via `GENERIC_COUNCILS`, validate, then flip `GENERIC_ENABLED=true` for national coverage.

## Debug HTML

On any non-`high` outcome, the final page HTML is saved to `output/debug/<council>/<application_uid>.html` (disk only, never Storage), capped at 100 files/run (oldest deleted first). Invaluable for understanding a council's structure without re-running. Anti-bot/login pages are **not** saved (privacy — our detection could be wrong).

## Privacy

Personal name values are **never** logged — only counts (`fields=N`). Anti-bot logs are marker + council + skip action only.

## No council-specific code

`generic.js` is purely pattern-based. If a council needs `if council === 'X'` handling, that's a signal it needs its **own adapter** — the harvester logs it as a candidate and moves on, rather than special-casing.

---

## Test plan

Run in this order. Generic is opt-in, so the first two prove no regression before any generic runs.

### 1. Smoke test — existing Idox adapter, no regression
```
LOCATION=Nottingham MAX_APPLICATIONS=2 DISABLE_RESUME=true npm start
```
Expect: `adapter: idox`, documents tagged `extraction_method='idox'`, `scrape_status='scraped'`. Generic never invoked.

### 2. First generic test — one Northgate council, opt-in
```
LOCATION=Wandsworth MAX_APPLICATIONS=2 GENERIC_ENABLED=true DISABLE_RESUME=true npm start
```
Expect: `Detected Platform: NORTHGATE (adapter: generic)`. Likely `generic_scraped` with `medium`/`low` confidence (Northgate is JS-heavy — fields maybe, docs uncertain), or `blocked_anti_bot`. HTML saved under `output/debug/Wandsworth/` on non-`high`.

### 3. Fan-out — 3 councils via the allow-list (national still off)
```
GENERIC_COUNCILS=Wandsworth,Birmingham,Colchester MAX_APPLICATIONS=2 DISABLE_RESUME=true npm start
```
(Drive `LOCATION` per council, or run the Phase-10 location job.) Expect a mix of statuses — that's the design working. Inspect `output/debug/<council>/*.html` for the misses.

> Test council #10 = **Colchester** (`https://www.colchester.gov.uk/planning-search/`, classified `unknown` → generic) — a true bespoke portal. **Pending sign-off** before use as a live test; alternative: Havering (`development.havering.gov.uk/OcellaWeb/planningSearch`).

### Honest read of results
If all Northgate councils end at `failed`/`blocked_anti_bot` with no extractions, that's a signal **Northgate needs a dedicated adapter** — not that generic is broken. Recording the honest status is the point.
