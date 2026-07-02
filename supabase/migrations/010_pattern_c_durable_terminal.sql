-- ============================================================
-- Planning Scraper — Pattern C durable is_terminal (data reset, optional)
--
-- Context: prior to the durable-terminal fix, mapApplication derived is_terminal
-- from Planit status on EVERY upsert — including the pre-loop batch upsert, which
-- runs before the terminal-skip gate reads the row. That re-flipped is_terminal
-- back to true from Planit status each run, undoing migration-009's reset and
-- letting the recheck_count > 0 gate skip applications that were never actually
-- scraped. The code now sets is_terminal ONLY from the post-scrape / terminal-skip
-- flows (opts.setTerminalFromStatus), so is_terminal is a durable "we've scraped
-- this and it's decided" signal, and the batch/queued/thin paths never touch it.
--
-- This migration cleans up rows left in a bad state by the old behaviour: rows
-- flagged terminal (and/or with a bumped recheck_count) that were NEVER actually
-- scraped — no documents in the DB and a status_scrape marker showing we didn't
-- successfully extract. Clearing is_terminal=false, recheck_count=0 lets the next
-- run treat them as a genuine first encounter and run the adapter; the post-scrape
-- upsert will then set is_terminal correctly from the live status.
--
-- SAFE: only touches rows with ZERO documents and a non-scraped scrape_status.
-- Rows that were genuinely scraped (any document present) are untouched, so
-- decided applications keep their terminal flag and stay cheap on daily re-runs.
--
-- NOT auto-applied — review, then apply manually.
-- ============================================================

UPDATE public.applications
SET
  is_terminal = false,
  recheck_count = 0
WHERE id IN (
  SELECT a.id
  FROM public.applications a
  LEFT JOIN public.documents d ON d.application_id = a.id
  WHERE a.scrape_status IN ('skipped_terminal', 'skipped_filter',
                            'missing_url', 'failed', 'no_documents')
  GROUP BY a.id
  HAVING COUNT(d.id) = 0
);
