import fs from 'fs';
import path from 'path';

// Define the root of the project to access the output directory
// dashboard/src/lib/api.ts -> dashboard/src/lib -> dashboard/src -> dashboard -> planning-scraper
const OUTPUT_DIR = path.join(process.cwd(), '..', 'output');
const MASTER_DATASET_PATH = path.join(OUTPUT_DIR, 'master_dataset.json');
const CHANGE_LOG_PATH = path.join(OUTPUT_DIR, 'change_log.json');

// Define types based on what we've built in datasetBuilder.js and changeDetector.js
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

/**
 * Loads the canonical master dataset directly from disk.
 * Returns an empty array if the file doesn't exist yet.
 */
export function getMasterDataset(): ApplicationRecord[] {
  try {
    if (fs.existsSync(MASTER_DATASET_PATH)) {
      const data = fs.readFileSync(MASTER_DATASET_PATH, 'utf8');
      if (!data || data.trim() === '') return [];
      const records = JSON.parse(data) as ApplicationRecord[];
      return records.map(record => ({
        ...record,
        documents: (record.documents || []).map(doc => {
          const localPath = doc.local_path || doc.filename;
          const absoluteLocalPath = localPath
            ? path.resolve(path.join(process.cwd(), '..'), localPath)
            : "";
          const hasLocalPdf = localPath
            && absoluteLocalPath.startsWith(path.resolve(path.join(process.cwd(), '..', 'output')) + path.sep)
            && fs.existsSync(absoluteLocalPath);
          return {
            ...doc,
            name: doc.name || path.basename(localPath || doc.filename || "Document"),
            filename: doc.filename || localPath || "",
            url: hasLocalPdf ? `/api/files?path=${encodeURIComponent(localPath)}` : doc.url,
          };
        }),
      }));
    }
  } catch (error) {
    console.error('Failed to read master_dataset.json:', error);
  }
  return [];
}

/**
 * Loads the change log array directly from disk.
 * Returns an empty array if the file doesn't exist yet.
 */
export function getChangeLog(): ChangeLogEntry[] {
  try {
    if (fs.existsSync(CHANGE_LOG_PATH)) {
      const data = fs.readFileSync(CHANGE_LOG_PATH, 'utf8');
      if (!data || data.trim() === '') return [];
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Failed to read change_log.json:', error);
  }
  return [];
}

/**
 * Retrieves a single application by its unique ID.
 */
export function getApplicationById(id: string): ApplicationRecord | null {
  const records = getMasterDataset();
  // Try to match by application_id first; fallback to title when id not present
  const decodedId = decodeURIComponent(id);
  return records.find(r => r.application_id === decodedId || r.title === decodedId) || null;
}
