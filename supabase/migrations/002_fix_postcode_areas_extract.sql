-- ============================================================
-- Fix: postcode_areas.extract column was missing in the live DB.
-- The Phase-10 location job filters on it:
--   src/db/repositories/postcodeAreasRepository.js → .eq('extract', true)
-- Idempotent: safe to run more than once.
-- ============================================================

alter table public.postcode_areas
  add column if not exists extract boolean default false;
