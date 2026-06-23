-- ============================================================
-- Planning Scraper — Supabase schema
-- Reverse-engineered from the repository's repository-layer field maps:
--   src/db/repositories/*.js  and  src/db/storage.js
--
-- Design rules:
--   * Files live in Supabase STORAGE; rows store only metadata + pointers
--     (storage_bucket / storage_path). No bytea / blob columns anywhere.
--   * All identifiers are <= 63 chars (Postgres truncation limit).
--   * Date-ish columns that the scraper passes through RAW are typed text
--     on purpose, so non-ISO strings don't fail inserts. document_date is
--     date because documentsRepository.normalizeDate() always coerces it.
--
-- Apply: paste into the Supabase SQL editor and run, OR
--        supabase db push (if using the Supabase CLI).
-- ============================================================

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ── applications ────────────────────────────────────────────
-- src/db/repositories/applicationsRepository.js → mapApplication()
create table if not exists public.applications (
  id                uuid primary key default gen_random_uuid(),
  application_uid   text not null unique,           -- upsert onConflict key
  council           text,
  platform          text,
  address           text,
  proposal          text,
  status            text,
  applicant         text,
  agent             text,
  application_type  text,
  source_url        text,
  documents_url     text,
  validated_at      text,
  received_at       text,
  decision          text,
  decision_date     text,
  scrape_status     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ── documents ───────────────────────────────────────────────
-- src/db/repositories/documentsRepository.js → mapDocument()
create table if not exists public.documents (
  id                  uuid primary key default gen_random_uuid(),
  application_id      uuid not null references public.applications(id) on delete cascade,
  document_name       text not null,
  document_type       text,
  document_category   text,
  document_date       date,
  source_url          text not null,
  local_path          text,
  sha256_hash         text,
  mime_type           text,
  file_size           bigint,
  confidence_score    numeric,
  extraction_status   text,
  storage_bucket      text,                          -- pointer into Storage
  storage_path        text,                          -- object key in Storage
  storage_mime_type   text,
  storage_uploaded_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (application_id, source_url)                -- upsert onConflict key
);

create index if not exists idx_documents_application_id on public.documents (application_id);
create index if not exists idx_documents_source_url     on public.documents (source_url);

-- ── intelligence ────────────────────────────────────────────
-- src/db/repositories/intelligenceRepository.js → mapIntelligence()
create table if not exists public.intelligence (
  id                uuid primary key default gen_random_uuid(),
  document_id       uuid not null references public.documents(id) on delete cascade,
  extracted_text    text,
  metadata_json     jsonb,
  classification    jsonb,
  confidence_score  numeric,
  scanned_document  boolean default false,
  extraction_engine text not null default 'pdf-parse',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (document_id, extraction_engine)            -- upsert onConflict key
);

-- ── scraping_runs ───────────────────────────────────────────
-- src/db/repositories/runsRepository.js
create table if not exists public.scraping_runs (
  id                   uuid primary key default gen_random_uuid(),
  started_at           timestamptz not null default now(),
  completed_at         timestamptz,
  run_status           text not null default 'running',
  total_applications   integer default 0,
  total_documents      integer default 0,
  successful_downloads integer default 0,
  failed_downloads     integer default 0,
  blocked_requests     integer default 0,
  runtime_seconds      numeric
);

-- ── change_log ──────────────────────────────────────────────
-- src/db/repositories/changeLogRepository.js
create table if not exists public.change_log (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid references public.applications(id) on delete set null,
  change_type     text not null,
  old_value       text,
  new_value       text,
  detected_at     timestamptz not null default now()
);

create index if not exists idx_change_log_detected_at on public.change_log (detected_at desc);

-- ── postcode_areas (Phase 10 source-of-truth; read-only from scraper) ─
-- src/db/repositories/postcodeAreasRepository.js
create table if not exists public.postcode_areas (
  id          uuid primary key default gen_random_uuid(),
  postcode    text,
  region      text,
  source_url  text,
  extract     boolean default false
);

-- ── keep updated_at fresh on UPDATE (upserts that hit a conflict) ────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_applications_touch on public.applications;
create trigger trg_applications_touch before update on public.applications
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_documents_touch on public.documents;
create trigger trg_documents_touch before update on public.documents
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_intelligence_touch on public.intelligence;
create trigger trg_intelligence_touch before update on public.intelligence
  for each row execute function public.touch_updated_at();
