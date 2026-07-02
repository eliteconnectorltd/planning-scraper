// Shared data types, lifted verbatim from the old dashboard's `src/lib/api.ts`.
// Only the TYPES are carried over here. The disk-reading functions
// (getMasterDataset / getChangeLog / getApplicationById) were Node `fs` code
// for the local JSON fallback and are intentionally NOT ported — the React
// SPA is 100% Supabase-driven. See CONVERSION_LOG.md → Divergences.

export interface DocumentInfo {
  name: string;
  type: string;
  filename: string;
  hash: string;
  date?: string;
  url?: string;
  description?: string;
  local_path?: string;
}

export interface IntelligenceOutput {
  model?: string;
  version?: string;
  summary?: string;
  extracted_keywords?: string[];
  confidence?: number;
  classification?: { category?: string; confidence?: number; signals?: string[] };
  metadata?: Record<string, unknown>;
}

export interface TimelineEvent {
  type: string;
  date: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface ApplicationRecord {
  application_id: string;
  council: string;
  address: string;
  proposal: string;
  status: string | null;
  decision: string | null;
  decision_date: string | null;
  applicant: string | null;
  platform: string;
  planitUrl?: string;
  sourceUrl?: string;
  documents: DocumentInfo[];
  intelligence: IntelligenceOutput[];
  timeline: TimelineEvent[];
  hashes: Array<{ filename?: string; hash?: string; computed_at?: string }>;
  updated_at: string;
  title?: string;
  planit_url?: string;
  source_url?: string;
}

export interface ChangeItem {
  application_id?: string;
  council?: string;
  proposal?: string;
  filename?: string;
  type?: string;
  url?: string;
  previous_decision?: string | null;
  new_decision?: string | null;
  previous_hash?: string;
  new_hash?: string;
}

export interface ChangePayload {
  new_applications?: ChangeItem[];
  removed_applications?: ChangeItem[];
  new_documents?: ChangeItem[];
  changed_hashes?: ChangeItem[];
  updated_decisions?: ChangeItem[];
  revised_plans?: ChangeItem[];
  [key: string]: ChangeItem[] | undefined;
}

export interface DiffSummary {
  new_applications: number;
  removed_applications: number;
  new_documents: number;
  changed_hashes: number;
  updated_decisions: number;
  revised_plans: number;
}

export interface ChangeLogEntry {
  run_id: string;
  run_at: string;
  triggered_by: string;
  summary: DiffSummary;
  changes: ChangePayload;
}

// ── Structured scraper logging (migration 011: scrape_runs / scrape_events) ────
export type ScrapeRunStatus = 'running' | 'completed' | 'failed' | 'partial' | 'aborted';
export type ScrapeEventLevel = 'info' | 'warn' | 'error' | 'debug';

export interface ScrapeRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: ScrapeRunStatus;
  trigger: string;
  councils_attempted: number;
  councils_succeeded: number;
  councils_failed: number;
  applications_seen: number;
  applications_scraped_ok: number;
  applications_scraped_failed: number;
  applications_skipped_terminal: number;
  applications_skipped_filter: number;
  applications_skipped_no_docs: number;
  documents_downloaded: number;
  documents_skipped_known: number;
  documents_failed: number;
  error_summary: string | null;
  config_snapshot: Record<string, unknown> | null;
  hostname: string | null;
  scraper_version: string | null;
  created_at: string;
}

export interface ScrapeEvent {
  id: number;
  run_id: string;
  ts: string;
  level: ScrapeEventLevel;
  stage: string;
  council: string | null;
  application_uid: string | null;
  adapter: string | null;
  message: string;
  details: Record<string, unknown> | null;
  duration_ms: number | null;
}

// Enriched `details` shapes for specific event stages. All fields optional —
// events written before the reason-code change won't have them; `ScrapeEvent.details`
// stays `Record<string, unknown> | null` and pages narrow to these where needed.
export interface DocumentEventDetails {
  status?: 'downloaded' | 'skipped' | 'failed';
  reason_code?: string;
  reason_message?: string;
  doc_url?: string;
  doc_name?: string | null;
  http_status?: number;
  error_message?: string;
  error_stack?: string;
  bytes?: number;
  storage_path?: string;
  duration_ms?: number;
}

export interface AdapterMetadataEventDetails {
  reason_code?: string;
  reason_message?: string;
  fields_captured?: string[];
  fields_attempted?: string[];
  fields_null?: string[];
  error_message?: string;
}
