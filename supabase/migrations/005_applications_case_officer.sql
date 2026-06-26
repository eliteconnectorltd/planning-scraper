-- ============================================================
-- Planning Scraper — applications.case_officer (additive)
--
-- The generic harvester (src/adapters/generic.js) extracts the case officer
-- name via label-based field extraction, but the applications table had no
-- column for it (only applicant + agent existed, from migration 001). Add it.
--
-- Single-purpose migration (matches the existing one-thing-per-file pattern).
-- Idempotent (IF NOT EXISTS). NOT auto-applied — review then run manually.
-- ============================================================

alter table public.applications
  add column if not exists case_officer text;  -- e.g. "Jane Smith"; null when redacted/absent
