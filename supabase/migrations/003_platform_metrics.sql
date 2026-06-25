-- ============================================================
-- Planning Scraper — platform_metrics table
--
-- Reverse-engineered from src/platforms/fingerprint.js → recordPlatformMetric().
-- The audit found this table is referenced (read + upsert) but was never
-- created, so every recordPlatformMetric() call errored and was silently
-- swallowed by the best-effort .catch() wrappers.
--
-- fingerprint.js writes these columns and upserts on (portal_host, platform):
--   portal_host, platform,
--   success_count, block_count, total_extractions, total_response_ms,
--   updated_at
--
-- Apply: paste into the Supabase SQL editor and run (idempotent), OR
--        supabase db push.
-- ============================================================

create table if not exists public.platform_metrics (
  id                uuid primary key default gen_random_uuid(),
  portal_host       text not null,
  platform          text not null,
  success_count     integer not null default 0,
  block_count       integer not null default 0,
  total_extractions integer not null default 0,
  total_response_ms bigint  not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (portal_host, platform)                       -- upsert onConflict key
);

create index if not exists idx_platform_metrics_host on public.platform_metrics (portal_host);

-- Keep updated_at fresh on UPDATE (reuses the trigger fn from 001_planning_schema.sql).
drop trigger if exists trg_platform_metrics_touch on public.platform_metrics;
create trigger trg_platform_metrics_touch before update on public.platform_metrics
  for each row execute function public.touch_updated_at();
