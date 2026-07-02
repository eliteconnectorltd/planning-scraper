-- ============================================================
-- Migration 011: Structured logging for scraper runs and events
--
-- Two tables:
--   scrape_runs   — one row per scraper invocation (aggregate summary). Kept forever.
--   scrape_events — event stream during a run (many per run). Auto-pruned after 30 days
--                   by cleanup_old_scrape_events() (run nightly by an external scheduler).
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE). Applied MANUALLY by the user.
-- Apply: paste into the Supabase SQL editor and run, OR supabase db push.
-- ============================================================

create extension if not exists "pgcrypto";  -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS public.scrape_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial', 'aborted')),
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'scheduled', 'cli')),

  -- Council-level counters
  councils_attempted INT NOT NULL DEFAULT 0,
  councils_succeeded INT NOT NULL DEFAULT 0,
  councils_failed INT NOT NULL DEFAULT 0,

  -- Application-level counters
  applications_seen INT NOT NULL DEFAULT 0,
  applications_scraped_ok INT NOT NULL DEFAULT 0,
  applications_scraped_failed INT NOT NULL DEFAULT 0,
  applications_skipped_terminal INT NOT NULL DEFAULT 0,
  applications_skipped_filter INT NOT NULL DEFAULT 0,
  applications_skipped_no_docs INT NOT NULL DEFAULT 0,

  -- Document-level counters
  documents_downloaded INT NOT NULL DEFAULT 0,
  documents_skipped_known INT NOT NULL DEFAULT 0,
  documents_failed INT NOT NULL DEFAULT 0,

  -- Top-level error (only set if the run itself crashed, not per-council errors)
  error_summary TEXT,

  -- Configuration snapshot for this run
  config_snapshot JSONB,

  -- Host info for debugging
  hostname TEXT,
  scraper_version TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scrape_runs_started_at_desc_idx
  ON public.scrape_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS scrape_runs_status_idx
  ON public.scrape_runs (status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS public.scrape_events (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.scrape_runs(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error', 'debug')),
  stage TEXT NOT NULL,
  council TEXT,
  application_uid TEXT,
  adapter TEXT,
  message TEXT NOT NULL,
  details JSONB,
  duration_ms INT
);

CREATE INDEX IF NOT EXISTS scrape_events_run_id_ts_idx
  ON public.scrape_events (run_id, ts);
CREATE INDEX IF NOT EXISTS scrape_events_ts_desc_idx
  ON public.scrape_events (ts DESC);
CREATE INDEX IF NOT EXISTS scrape_events_council_idx
  ON public.scrape_events (council) WHERE council IS NOT NULL;
CREATE INDEX IF NOT EXISTS scrape_events_application_uid_idx
  ON public.scrape_events (application_uid) WHERE application_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS scrape_events_level_error_idx
  ON public.scrape_events (run_id, ts) WHERE level IN ('warn', 'error');

-- Retention cleanup function
CREATE OR REPLACE FUNCTION public.cleanup_old_scrape_events()
RETURNS TABLE(deleted_count BIGINT) AS $$
DECLARE
  rows_deleted BIGINT;
BEGIN
  DELETE FROM public.scrape_events
  WHERE ts < now() - INTERVAL '30 days';
  GET DIAGNOSTICS rows_deleted = ROW_COUNT;
  RETURN QUERY SELECT rows_deleted;
END;
$$ LANGUAGE plpgsql;

-- Optional: seed a comment for schema documentation
COMMENT ON TABLE public.scrape_runs IS 'One row per scraper invocation. Retained forever.';
COMMENT ON TABLE public.scrape_events IS 'Event stream during scrape runs. Auto-pruned after 30 days.';
COMMENT ON COLUMN public.scrape_events.stage IS 'Free-form stage identifier. Common values: planit_fetch, detector, adapter_start, adapter_metadata, adapter_documents, document_download, db_upsert, terminal_skip, postcode_skip, run_start, run_finish.';
