import { getMasterDataset, getChangeLog, ApplicationRecord, ChangeLogEntry } from "./api";
import { getSupabaseServerClient } from "./supabase";

export interface PaginatedResult<T> {
  data: T[];
  count: number;
  page: number;
  pageSize: number;
  source: "supabase" | "json";
}

function normalizePage(page?: string | number, pageSize?: string | number) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 25, 1), 100);
  return {
    page: safePage,
    pageSize: safePageSize,
    from: (safePage - 1) * safePageSize,
    to: safePage * safePageSize - 1,
  };
}

type SupabaseDocumentRow = {
  id?: string | null;
  document_name?: string | null;
  document_type?: string | null;
  document_category?: string | null;
  document_date?: string | null;
  created_at?: string | null;
  source_url?: string | null;
  local_path?: string | null;
  sha256_hash?: string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
  storage_mime_type?: string | null;
  intelligence?: SupabaseIntelligenceRow[] | null;
};

type SupabaseIntelligenceRow = {
  extracted_text?: string | null;
  metadata_json?: Record<string, unknown> | null;
  classification?: { category?: string; confidence?: number; signals?: string[] } | null;
  confidence_score?: number | null;
  scanned_document?: boolean | null;
  extraction_engine?: string | null;
};

type SupabaseApplicationRow = {
  application_uid?: string | null;
  council?: string | null;
  address?: string | null;
  proposal?: string | null;
  decision?: string | null;
  decision_date?: string | null;
  applicant?: string | null;
  platform?: string | null;
  source_url?: string | null;
  documents_url?: string | null;
  validated_at?: string | null;
  received_at?: string | null;
  updated_at?: string | null;
  documents?: SupabaseDocumentRow[] | null;
};

function parseDisplayDate(value?: string | null) {
  if (!value) return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  const text = String(value);
  const natural = text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i);
  if (natural) {
    const months: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const [, day, month, year] = natural;
    return `${year}-${months[month.slice(0, 3).toLowerCase()]}-${day.padStart(2, "0")}T00:00:00.000Z`;
  }

  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (numeric) {
    const [, day, month, rawYear] = numeric;
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`;
  }

  return null;
}

function inferValidatedDate(row: SupabaseApplicationRow) {
  return parseDisplayDate(row.validated_at)
    || parseDisplayDate(row.received_at)
    || parseDisplayDate(row.proposal)
    || parseDisplayDate(row.updated_at);
}

function ensurePdfFilename(name?: string | null) {
  const cleanName = (name || "document").trim() || "document";
  return cleanName.toLowerCase().endsWith(".pdf") ? cleanName : `${cleanName}.pdf`;
}

async function createDocumentUrl(row: SupabaseDocumentRow) {
  const client = getSupabaseServerClient();
  if (client && row.storage_bucket && row.storage_path) {
    const { data } = await client.storage
      .from(row.storage_bucket)
      .createSignedUrl(row.storage_path, 60 * 60, {
        download: ensurePdfFilename(row.document_name),
      });
    if (data?.signedUrl) return data.signedUrl;
  }

  return row.source_url || undefined;
}

async function mapSupabaseDocument(row: SupabaseDocumentRow) {
  return {
    name: row.document_name || "Document",
    type: row.document_category || row.document_type || "Document",
    filename: row.local_path || ensurePdfFilename(row.document_name),
    hash: row.sha256_hash || "",
    date: parseDisplayDate(row.document_date) || undefined,
    url: await createDocumentUrl(row),
  };
}

function mapSupabaseIntelligence(row: SupabaseIntelligenceRow) {
  return {
    model: row.extraction_engine || "pdf-parse",
    summary: typeof row.metadata_json?.summary === "string" ? row.metadata_json.summary : undefined,
    confidence: row.confidence_score || row.classification?.confidence || undefined,
    classification: row.classification || undefined,
    metadata: row.metadata_json || undefined,
  };
}

function buildTimeline(row: SupabaseApplicationRow, documents: Awaited<ReturnType<typeof mapSupabaseDocument>>[]) {
  const events = [];
  const receivedAt = parseDisplayDate(row.received_at);
  const validatedAt = inferValidatedDate(row);
  const decisionAt = parseDisplayDate(row.decision_date);

  if (receivedAt) {
    events.push({
      type: "received",
      date: receivedAt,
      description: "Application received by the planning authority.",
    });
  }
  if (validatedAt && validatedAt !== receivedAt) {
    events.push({
      type: "validated",
      date: validatedAt,
      description: "Application validated by the planning authority.",
    });
  }
  for (const doc of documents) {
    if (doc.date) {
      events.push({
        type: "document",
        date: doc.date,
        description: `${doc.type}: ${doc.name}`,
      });
    }
  }
  if (decisionAt) {
    events.push({
      type: "decision",
      date: decisionAt,
      description: row.decision ? `Decision recorded: ${row.decision}` : "Decision recorded.",
    });
  }
  return events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

async function mapSupabaseApplication(row: SupabaseApplicationRow): Promise<ApplicationRecord> {
  const documents = await Promise.all((row.documents || []).map(mapSupabaseDocument));
  const intelligence = (row.documents || []).flatMap(doc => (doc.intelligence || []).map(mapSupabaseIntelligence));
  return {
    application_id: row.application_uid || "",
    council: row.council || "",
    address: row.address || "",
    proposal: row.proposal || "",
    decision: row.decision || null,
    decision_date: row.decision_date || null,
    applicant: row.applicant || null,
    platform: row.platform || "",
    source_url: row.source_url || undefined,
    planit_url: row.source_url || undefined,
    documents,
    intelligence,
    timeline: buildTimeline(row, documents),
    hashes: documents.map(doc => ({ filename: doc.filename, hash: doc.hash })).filter(doc => doc.hash),
    updated_at: row.updated_at || "",
  };
}

export async function getApplicationsPage(options: {
  page?: string | number;
  pageSize?: string | number;
  q?: string;
  council?: string;
  decision?: string;
}): Promise<PaginatedResult<ApplicationRecord>> {
  const client = getSupabaseServerClient();
  const { page, pageSize, from, to } = normalizePage(options.page, options.pageSize);

  if (client) {
    let query = client
      .from("applications")
      .select("*, documents(id, document_name, document_type, document_category, document_date, created_at, source_url, local_path, sha256_hash, storage_bucket, storage_path, storage_mime_type, intelligence(extracted_text, metadata_json, classification, confidence_score, scanned_document, extraction_engine))", { count: "exact" })
      .order("updated_at", { ascending: false })
      .range(from, to);
    if (options.council) query = query.eq("council", options.council);
    if (options.decision) query = query.eq("decision", options.decision);
    if (options.q) {
      const q = `%${options.q}%`;
      query = query.or(`application_uid.ilike.${q},address.ilike.${q},proposal.ilike.${q}`);
    }
    const { data, count, error } = await query;
    if (!error && data && data.length > 0) {
      const mapped: ApplicationRecord[] = await Promise.all(data.map(mapSupabaseApplication));
      return { data: mapped, count: count || 0, page, pageSize, source: "supabase" };
    }
  }

  let records = getMasterDataset();
  if (options.q) {
    const q = options.q.toLowerCase();
    records = records.filter(r =>
      [r.application_id, r.address, r.proposal, r.council].some(value => String(value || "").toLowerCase().includes(q))
    );
  }
  if (options.council) records = records.filter(r => r.council === options.council);
  if (options.decision) records = records.filter(r => r.decision === options.decision);
  return { data: records.slice(from, to + 1), count: records.length, page, pageSize, source: "json" };
}

export async function getApplicationDetail(id: string): Promise<ApplicationRecord | null> {
  const client = getSupabaseServerClient();
  const decodedId = decodeURIComponent(id);

  if (client) {
    const { data, error } = await client
      .from("applications")
      .select("*, documents(id, document_name, document_type, document_category, document_date, created_at, source_url, local_path, sha256_hash, storage_bucket, storage_path, storage_mime_type, intelligence(extracted_text, metadata_json, classification, confidence_score, scanned_document, extraction_engine))")
      .eq("application_uid", decodedId)
      .maybeSingle();

    if (!error && data) {
      return mapSupabaseApplication(data);
    }
  }

  return getMasterDataset().find(r => r.application_id === decodedId || r.title === decodedId) || null;
}

export async function getChangeFeed(options: { page?: string | number; pageSize?: string | number }): Promise<PaginatedResult<ChangeLogEntry>> {
  const client = getSupabaseServerClient();
  const { page, pageSize, from, to } = normalizePage(options.page, options.pageSize);

  if (client) {
    const { data, count, error } = await client.from("change_log").select("*", { count: "exact" }).order("detected_at", { ascending: false }).range(from, to);
    if (!error && data) {
      const entries = data.map(row => ({
        run_id: row.id,
        run_at: row.detected_at,
        triggered_by: "supabase",
        summary: {
          new_applications: row.change_type === "new_application" ? 1 : 0,
          removed_applications: row.change_type === "removed_application" ? 1 : 0,
          new_documents: row.change_type === "new_document" ? 1 : 0,
          changed_hashes: row.change_type === "changed_hash" ? 1 : 0,
          updated_decisions: row.change_type === "updated_decision" ? 1 : 0,
          revised_plans: row.change_type === "revised_plan" ? 1 : 0,
        },
        changes: { [row.change_type]: [row.new_value || row.old_value] },
      })) as ChangeLogEntry[];
      return { data: entries, count: count || 0, page, pageSize, source: "supabase" };
    }
  }

  const changes = getChangeLog().reverse();
  return { data: changes.slice(from, to + 1), count: changes.length, page, pageSize, source: "json" };
}
