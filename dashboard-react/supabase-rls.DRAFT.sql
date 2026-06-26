-- =============================================================================
-- DRAFT — read-only RLS for the React (anon-key) dashboard
-- =============================================================================
-- DO NOT let an agent apply this. The dashboard owner applies it manually
-- (Phase 2/3 approval terms). Until it is applied, the new SPA authenticates
-- with the publishable/anon key and every query returns ZERO rows.
--
-- Why this exists
-- ---------------
-- The old Next.js dashboard read Supabase with the SERVICE-ROLE key on the
-- server, which bypasses RLS entirely. The React SPA cannot hold that secret,
-- so it uses the publishable (anon) key in the browser. For the anon role to
-- read data, the tables need explicit row-level-security SELECT policies.
--
-- Scope: READ-ONLY. The anon role gets SELECT and nothing else. All writes
-- remain service-role-only (the scraper is unaffected). This is strictly more
-- locked-down than today's state (RLS off + implicit table grants).
--
-- Tables the dashboard reads (see dashboard/AGENTS.md):
--   applications, documents, intelligence  (joined in one select)
--   change_log                              (changes feed)
--
-- Run in a Supabase staging branch first if you have one, then production.
-- =============================================================================

-- 1. applications ------------------------------------------------------------
alter table public.applications enable row level security;

drop policy if exists "anon read applications" on public.applications;
create policy "anon read applications"
  on public.applications
  for select
  to anon
  using (true);

-- 2. documents ---------------------------------------------------------------
alter table public.documents enable row level security;

drop policy if exists "anon read documents" on public.documents;
create policy "anon read documents"
  on public.documents
  for select
  to anon
  using (true);

-- 3. intelligence ------------------------------------------------------------
alter table public.intelligence enable row level security;

drop policy if exists "anon read intelligence" on public.intelligence;
create policy "anon read intelligence"
  on public.intelligence
  for select
  to anon
  using (true);

-- 4. change_log --------------------------------------------------------------
alter table public.change_log enable row level security;

drop policy if exists "anon read change_log" on public.change_log;
create policy "anon read change_log"
  on public.change_log
  for select
  to anon
  using (true);

-- =============================================================================
-- 5. Storage: signed URLs for private document PDFs
-- =============================================================================
-- The dashboard mints 1-hour signed URLs for documents in the PRIVATE
-- 'planning-documents' bucket (createDocumentUrl, TTL 3600s). With the
-- service-role key this worked because it bypasses Storage RLS. With the anon
-- key, the anon role needs SELECT on the storage objects in that bucket so it
-- can create signed URLs. The bucket STAYS PRIVATE — this grants the ability to
-- sign, not public read.
--
-- NOTE: storage.objects already has RLS enabled by Supabase. We only add a
-- SELECT policy scoped to this one bucket.

drop policy if exists "anon sign planning documents" on storage.objects;
create policy "anon sign planning documents"
  on storage.objects
  for select
  to anon
  using (bucket_id = 'planning-documents');

-- =============================================================================
-- ASSUMPTION TO VERIFY (flagged per Phase 3 stop-condition)
-- -----------------------------------------------------------------------------
-- This assumes a single SELECT policy on storage.objects is sufficient for the
-- anon role to call createSignedUrl() on the private bucket. If, after applying
-- this, document links still fail to sign (the UI would fall back to each
-- document's original source_url), the storage policy may need to be widened or
-- adjusted — STOP and report rather than guessing further.
-- =============================================================================
