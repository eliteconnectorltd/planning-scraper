-- ============================================================
-- Planning Scraper — documents extraction tracking (additive)
--
-- Operational visibility for the multi-adapter download pipeline:
--   extraction_method — which adapter produced/downloaded the document
--                       ('idox' | 'arcus' | 'salesforce' | 'generic')
--   error_message     — failure context for a document download (was previously
--                       computed in downloadManager but DISCARDED — never stored)
--
-- Single-purpose migration. Idempotent (IF NOT EXISTS). NOT auto-applied.
-- ============================================================

alter table public.documents
  add column if not exists extraction_method text,  -- 'idox' | 'arcus' | 'salesforce' | 'generic'
  add column if not exists error_message    text;   -- e.g. "HTTP Error: 403"; null on success
