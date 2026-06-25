-- ============================================================
-- Planning Scraper — applications extended Planit metadata (additive)
--
-- Adds columns for the broader set of fields some councils expose via Planit's
-- detail API (other_fields). Purely additive — no existing column is removed,
-- renamed, or retyped. Idempotent (IF NOT EXISTS), safe to re-run.
--
-- Mapping owner: src/index.js applyPlanitMetadata() (which now writes `decided_by`
-- to its OWN column instead of overloading `decision`).
--
-- Apply: paste into the Supabase SQL editor and run, OR supabase db push.
-- ============================================================

alter table public.applications
  add column if not exists decided_by              text,     -- WHO decided: "Delegated", "Committee", …
  add column if not exists postcode                text,     -- "N1 9BS"
  add column if not exists ward_name               text,     -- "Caledonian", "Muswell Hill", …
  add column if not exists uprn                    text,     -- keep TEXT — leading zeros matter
  add column if not exists planning_portal_id      text,     -- "PP-14787091"
  add column if not exists lat                     numeric,  -- 51.533180
  add column if not exists lng                     numeric,  -- -0.119876
  add column if not exists easting                 integer,  -- 530505
  add column if not exists northing                integer,  -- 183261
  add column if not exists n_statutory_days        integer,  -- 55
  add column if not exists n_documents             integer,  -- Planit's doc count (NOT a live count from our documents table)
  add column if not exists n_constraints           integer,  -- 8 (Croydon-style)
  add column if not exists n_comments              integer,  -- 0
  add column if not exists agent_company           text,     -- "DCSK"
  add column if not exists agent_address           text,     -- "91 Swains Lane LONDON N6 6PJ GB"
  add column if not exists target_decision_date    text,     -- "2026-08-16"
  add column if not exists consultation_start_date text,     -- "22/06/2026"
  add column if not exists comment_url             text,     -- real council comment URL (sentinel-filtered)
  add column if not exists map_url                 text;     -- real map URL (sentinel-filtered)

-- ⚠ DATE-TYPE WARNING (target_decision_date, consultation_start_date):
--   The scraper passes Planit date strings through RAW (never reformatted). ISO
--   values like "2026-08-16" cast cleanly to DATE, but DD/MM/YYYY values such as
--   "22/06/2026" will FAIL to insert under Postgres' default (ISO/MDY) datestyle
--   and would reject the whole application upsert. If your councils return
--   non-ISO dates here, change these two columns to TEXT (matching how 001 keeps
--   validated_at/received_at/decision_date as text on purpose), or normalise the
--   values before insert. Chosen DATE per the task spec — flagged for testing.

-- Useful lookup indexes (geo columns intentionally left unindexed — proper geo
-- querying needs PostGIS, which is out of scope here).
create index if not exists idx_applications_postcode  on public.applications (postcode);
create index if not exists idx_applications_ward_name on public.applications (ward_name);
