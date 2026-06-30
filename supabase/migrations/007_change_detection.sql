-- ============================================================
-- Planning Scraper — document change detection (Pattern C, additive)
--
-- Enables daily re-checking of ACTIVE applications for new documents while
-- skipping TERMINAL ones (decided/withdrawn/etc.), and records first/last
-- observation timestamps per document.
--
-- applications:
--   last_checked_at           — set ONLY when we attempted document extraction
--                               (terminal-skip, post-scrape, resume re-check).
--                               NOT general "last touched" (use updated_at for that).
--   documents_last_changed_at — set ONLY on a run where the document set changed
--                               (new or missing URLs vs the DB).
--   is_terminal               — true once status reaches a terminal value; such
--                               applications drop out of daily re-checks. Default
--                               false so all existing rows are re-checked once.
--   recheck_count             — incremented each time we re-encounter the uid.
--
-- documents:
--   first_seen_at — DB default now() on INSERT; never overwritten (mapDocument
--                   deliberately omits it from the upsert payload).
--   last_seen_at  — updated to now() on every upsert (incl. skipped_known).
--   status        — 'active' for now; 'removed' detection is Phase 5.
--
-- Idempotent (IF NOT EXISTS). NOT auto-applied — review, then apply manually.
-- ============================================================

alter table public.applications
  add column if not exists last_checked_at           timestamptz,
  add column if not exists documents_last_changed_at timestamptz,
  add column if not exists is_terminal               boolean default false,
  add column if not exists recheck_count             integer default 0;

-- Partial index: the daily re-check query scans only non-terminal applications,
-- ordered by how long ago they were last checked.
create index if not exists idx_applications_recheck
  on public.applications (is_terminal, last_checked_at)
  where is_terminal = false;

alter table public.documents
  add column if not exists first_seen_at timestamptz default now(),
  add column if not exists last_seen_at  timestamptz default now(),
  add column if not exists status        text default 'active'; -- 'active' | 'removed'
