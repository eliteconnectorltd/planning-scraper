<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Planning Intelligence Dashboard — Agent Guide

This Next.js app is the read UI for a **UK planning-application scraper**. The
scraper (the parent `planning-scraper-idox/` project) writes to **Supabase**
(Postgres + Storage); this dashboard reads from it. There is a JSON fallback for
local/offline use only.

> Earlier versions of this file documented an unrelated "construction permits"
> database (case_number/district/village/etc.) and a `read/search/count` tool
> API. **None of that exists in this project.** The accurate schema is below.

## Data flow (Supabase-first, JSON fallback)

- **Primary:** `dashboard/src/lib/supabase-api.ts` queries Supabase directly with
  the **server-side** service-role client (`dashboard/src/lib/supabase.ts`).
- **Fallback:** when Supabase is **not configured** or a query **errors**, it
  degrades to reading `../output/master_dataset.json` via
  `dashboard/src/lib/api.ts` (the legacy disk pipeline). A configured + reachable
  Supabase that returns **zero rows** is trusted as "0 results" — it does NOT
  fall through to JSON (so the UI never shows stale data while the DB is live).
- **Document files** live in **Supabase Storage**. `createDocumentUrl()` mints a
  1-hour **signed URL** from `storage_bucket` + `storage_path`; if absent it uses
  the document's original `source_url`.
- Every paginated response carries `source: "supabase" | "json"` so you can tell
  which path served the data.

## Environment variables (server-side only)

Create `dashboard/.env.local` (NOT committed). These are read with plain
`process.env` in server code — they are **not** `NEXT_PUBLIC_*` and must never be
exposed to the browser:

```
SUPABASE_URL=...                       # same project as the scraper
SUPABASE_SERVICE_ROLE_KEY=...          # SECRET service-role key (eyJ… JWT or sb_secret_…)
SUPABASE_DOCUMENTS_BUCKET=planning-documents
```

If these are absent the dashboard still boots and serves the JSON fallback.

## Supabase schema (source of truth)

Defined in `../supabase/migrations/`. The dashboard reads these tables:

### `applications`
`id` (uuid pk), `application_uid` (text, unique), `council`, `platform`,
`address`, `proposal`, `status`, `applicant`, `agent`, `application_type`,
`source_url`, `documents_url`, `validated_at` (text), `received_at` (text),
`decision`, `decision_date` (text), `scrape_status`, `created_at`, `updated_at`.

### `documents` (FK `application_id` → applications.id)
`id` (uuid pk), `document_name`, `document_type`, `document_category`,
`document_date` (date), `source_url`, `local_path`, `sha256_hash`, `mime_type`,
`file_size`, `confidence_score`, `extraction_status`, `storage_bucket`,
`storage_path`, `storage_mime_type`, `storage_uploaded_at`. Unique
`(application_id, source_url)`.

### `intelligence` (FK `document_id` → documents.id)
`id` (uuid pk), `extracted_text`, `metadata_json` (jsonb), `classification`
(jsonb), `confidence_score`, `scanned_document` (bool), `extraction_engine`.
Unique `(document_id, extraction_engine)`.

### Also present
`scraping_runs`, `change_log`, `postcode_areas`, `platform_metrics`.

The dashboard joins applications → documents → intelligence in one query (see
`getApplicationsPage` / `getApplicationDetail` in `supabase-api.ts`).

## API routes (`src/app/api/*`)

All thin wrappers over `supabase-api.ts`:
- `applications`, `search` — paginated application list (identical handlers).
- `dataset`, `analytics` — first 100 applications (analytics aggregates by council).
- `changes` — paginated change feed.
- `files` — serves a PDF from `../output/` **only** (disk fallback / legacy).
  Under the Supabase path, documents are served via signed Storage URLs instead.

## Conventions

- Server components / route handlers do the data fetching. Keep the service-role
  key server-side; never import `supabase.ts` into a client component.
- Don't reintroduce a parallel write path here — the dashboard is read-only.
  Writes happen in the scraper project.
- Document `type`/category strings come straight from the scraper's classifier;
  don't hardcode a fixed enum in the UI.
