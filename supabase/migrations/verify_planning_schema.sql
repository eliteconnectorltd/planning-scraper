-- ============================================================
-- Planning Scraper — schema VERIFICATION
-- Run this in the Supabase SQL editor AFTER applying 001_planning_schema.sql.
--
-- It does NOT modify anything. Every section returns rows you can eyeball,
-- and the final section returns a single PASS/FAIL summary table comparing
-- the live database against the contract the scraper code expects
-- (src/db/repositories/*.js + src/db/storage.js).
--
-- Read the LAST result set first: if every row says ✅ PASS, you're good.
-- Anything ❌ tells you exactly which table/column/constraint is missing.
-- ============================================================


-- ── 0. Quick existence check: all expected tables present? ──────────────
select
  t.expected_table,
  case when c.table_name is not null then '✅ present' else '❌ MISSING' end as status
from (values
  ('applications'), ('documents'), ('intelligence'),
  ('scraping_runs'), ('change_log'), ('postcode_areas')
) as t(expected_table)
left join information_schema.tables c
  on c.table_schema = 'public'
 and c.table_name   = t.expected_table
order by t.expected_table;


-- ── 1. Full column inventory for the public tables ─────────────────────
--    Eyeball this against the migration. Types should match:
--    text / uuid / date / bigint / numeric / boolean / jsonb / timestamptz.
select
  table_name,
  ordinal_position as pos,
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'applications','documents','intelligence',
    'scraping_runs','change_log','postcode_areas'
  )
order by table_name, ordinal_position;


-- ── 2. Constraints that the UPSERTs depend on ──────────────────────────
--    The scraper relies on these onConflict targets:
--      applications : UNIQUE (application_uid)
--      documents    : UNIQUE (application_id, source_url)
--      intelligence : UNIQUE (document_id, extraction_engine)
--    Plus the FKs documents→applications, intelligence→documents.
select
  tc.table_name,
  tc.constraint_type,
  tc.constraint_name,
  string_agg(kcu.column_name, ', ' order by kcu.ordinal_position) as columns
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name
 and kcu.table_schema    = tc.table_schema
where tc.table_schema = 'public'
  and tc.table_name in (
    'applications','documents','intelligence',
    'scraping_runs','change_log','postcode_areas'
  )
  and tc.constraint_type in ('PRIMARY KEY','UNIQUE','FOREIGN KEY')
group by tc.table_name, tc.constraint_type, tc.constraint_name
order by tc.table_name, tc.constraint_type;


-- ── 3. updated_at triggers present? (keep updated_at fresh on upsert) ───
select
  event_object_table as table_name,
  trigger_name,
  action_timing,
  event_manipulation
from information_schema.triggers
where trigger_schema = 'public'
  and event_object_table in ('applications','documents','intelligence')
order by event_object_table;


-- ── 4. Storage bucket present and PRIVATE? ─────────────────────────────
--    storage.js expects bucket 'planning-documents', public=false, 50MB limit.
--    (storage.buckets is readable with the service-role key.)
select
  id   as bucket,
  public,
  file_size_limit,
  case
    when id is null     then '❌ bucket MISSING — will be auto-created on first upload'
    when public is true then '⚠ bucket is PUBLIC — code expects private + signed URLs'
    else '✅ private bucket OK'
  end as status
from storage.buckets
where id = 'planning-documents';


-- ── 5. SINGLE PASS/FAIL SUMMARY (read this one) ────────────────────────
-- Compares the live schema to the exact (table, column, type) contract.
-- A row is ✅ PASS only if the column exists AND its type matches.
with expected(table_name, column_name, expected_type) as (
  values
    -- applications
    ('applications','id','uuid'),
    ('applications','application_uid','text'),
    ('applications','council','text'),
    ('applications','platform','text'),
    ('applications','address','text'),
    ('applications','proposal','text'),
    ('applications','status','text'),
    ('applications','applicant','text'),
    ('applications','agent','text'),
    ('applications','application_type','text'),
    ('applications','source_url','text'),
    ('applications','documents_url','text'),
    ('applications','validated_at','text'),
    ('applications','received_at','text'),
    ('applications','decision','text'),
    ('applications','decision_date','text'),
    ('applications','scrape_status','text'),
    ('applications','created_at','timestamp with time zone'),
    ('applications','updated_at','timestamp with time zone'),
    -- documents
    ('documents','id','uuid'),
    ('documents','application_id','uuid'),
    ('documents','document_name','text'),
    ('documents','document_type','text'),
    ('documents','document_category','text'),
    ('documents','document_date','date'),
    ('documents','source_url','text'),
    ('documents','local_path','text'),
    ('documents','sha256_hash','text'),
    ('documents','mime_type','text'),
    ('documents','file_size','bigint'),
    ('documents','confidence_score','numeric'),
    ('documents','extraction_status','text'),
    ('documents','storage_bucket','text'),
    ('documents','storage_path','text'),
    ('documents','storage_mime_type','text'),
    ('documents','storage_uploaded_at','timestamp with time zone'),
    ('documents','created_at','timestamp with time zone'),
    ('documents','updated_at','timestamp with time zone'),
    -- intelligence
    ('intelligence','id','uuid'),
    ('intelligence','document_id','uuid'),
    ('intelligence','extracted_text','text'),
    ('intelligence','metadata_json','jsonb'),
    ('intelligence','classification','jsonb'),
    ('intelligence','confidence_score','numeric'),
    ('intelligence','scanned_document','boolean'),
    ('intelligence','extraction_engine','text'),
    ('intelligence','created_at','timestamp with time zone'),
    ('intelligence','updated_at','timestamp with time zone'),
    -- scraping_runs
    ('scraping_runs','id','uuid'),
    ('scraping_runs','started_at','timestamp with time zone'),
    ('scraping_runs','completed_at','timestamp with time zone'),
    ('scraping_runs','run_status','text'),
    ('scraping_runs','total_applications','integer'),
    ('scraping_runs','total_documents','integer'),
    ('scraping_runs','successful_downloads','integer'),
    ('scraping_runs','failed_downloads','integer'),
    ('scraping_runs','blocked_requests','integer'),
    ('scraping_runs','runtime_seconds','numeric'),
    -- change_log
    ('change_log','id','uuid'),
    ('change_log','application_id','uuid'),
    ('change_log','change_type','text'),
    ('change_log','old_value','text'),
    ('change_log','new_value','text'),
    ('change_log','detected_at','timestamp with time zone'),
    -- postcode_areas
    ('postcode_areas','id','uuid'),
    ('postcode_areas','postcode','text'),
    ('postcode_areas','region','text'),
    ('postcode_areas','source_url','text'),
    ('postcode_areas','extract','boolean')
)
select
  e.table_name,
  e.column_name,
  e.expected_type,
  c.data_type as actual_type,
  case
    when c.column_name is null            then '❌ COLUMN MISSING'
    when c.data_type  <> e.expected_type  then '❌ TYPE MISMATCH'
    else '✅ PASS'
  end as result
from expected e
left join information_schema.columns c
  on c.table_schema = 'public'
 and c.table_name   = e.table_name
 and c.column_name  = e.column_name
order by
  (case when c.column_name is null or c.data_type <> e.expected_type then 0 else 1 end),
  e.table_name, e.column_name;
