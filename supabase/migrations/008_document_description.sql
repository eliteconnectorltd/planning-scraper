-- ============================================================
-- Planning Scraper — document description column (additive)
--
-- The Capita "Planning Case" gvResults table carries a per-row description
-- (Label2, e.g. "Site Plan East Elevation") that previously had nowhere to land.
-- This adds the column so the row-aware Capita parser can persist it.
--
-- Idempotent (IF NOT EXISTS). NOT auto-applied — review, then apply manually.
-- ============================================================

alter table public.documents
  add column if not exists description text;
