-- ============================================================
-- Planning Scraper — Pattern C first-run fix (data reset, optional)
--
-- Context: the original terminal-skip gate skipped any application whose status
-- was terminal on FIRST encounter, so already-decided applications (e.g. surfaced
-- by a date-range backfill) had is_terminal=true set from Planit status WITHOUT
-- their documents ever being fetched. The orchestrator now only skips a terminal
-- application once recheck_count > 0 (i.e. we have actually scraped it before).
--
-- This migration resets the rows stuck by the old behaviour so the next run will
-- scrape them once: is_terminal=true AND recheck_count=0 means "flagged terminal
-- but never actually scraped". Clearing both lets the orchestrator treat them as
-- first-encounter and run the adapter; mapApplication will re-set is_terminal from
-- the live status after that scrape.
--
-- SAFE: only touches rows that were never scraped (recheck_count = 0). Rows we have
-- scraped (recheck_count >= 1) are untouched, so genuinely-finished applications
-- keep their terminal flag and stay cheap on daily re-runs.
--
-- NOT auto-applied — review, then apply manually.
-- ============================================================

-- Reset applications that were marked terminal but have never actually been
-- scraped (zero documents in DB, regardless of recheck_count).
-- This handles rows where the original Phase 3 bug skipped them on first 
-- encounter, then subsequent runs bumped recheck_count via skip-upserts 
-- without ever fetching documents.
UPDATE applications
SET 
  is_terminal = false,
  recheck_count = 0
WHERE id IN (
  SELECT a.id 
  FROM applications a
  LEFT JOIN documents d ON d.application_id = a.id
  WHERE a.scrape_status = 'skipped_terminal'
  GROUP BY a.id
  HAVING COUNT(d.id) = 0
);
