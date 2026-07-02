import type { ScrapeRunStatus, ScrapeEventLevel } from "./types";

export const chip = "inline-flex w-fit items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium";

// Status colours per the Phase 3 spec.
export function statusChipClass(status: ScrapeRunStatus | string): string {
  switch (status) {
    case "running": return "border-blue-200 bg-blue-50 text-blue-700";
    case "completed": return "border-green-200 bg-green-50 text-green-700";
    case "partial": return "border-amber-200 bg-amber-50 text-amber-700";
    case "failed": return "border-red-200 bg-red-50 text-red-700";
    case "aborted": return "border-slate-200 bg-slate-100 text-slate-600";
    default: return "border-border bg-secondary text-muted-foreground";
  }
}

export function levelChipClass(level: ScrapeEventLevel | string): string {
  switch (level) {
    case "error": return "border-red-200 bg-red-50 text-red-700";
    case "warn": return "border-amber-200 bg-amber-50 text-amber-700";
    case "debug": return "border-slate-200 bg-slate-100 text-slate-500";
    default: return "border-border bg-secondary text-muted-foreground"; // info
  }
}

// Colour for a document/metadata reason_code chip.
//   downloaded_*  → green   (downloaded_no_storage is a degraded success → amber)
//   skipped_*     → grey
//   failed_http_4xx → amber (client/expected, e.g. 404 gone)
//   failed_* (5xx/network/timeout/other) → red
//   metadata_none/empty → amber; metadata_captured → grey
export function reasonCodeColor(code: string | null | undefined): string {
  const c = String(code || "");
  if (c === "downloaded_no_storage" || c === "scraped_no_docs") return "border-amber-200 bg-amber-50 text-amber-700";
  if (c.startsWith("downloaded") || c === "scraped_ok") return "border-green-200 bg-green-50 text-green-700";
  if (c.startsWith("skipped")) return "border-slate-200 bg-slate-100 text-slate-600";
  if (/^failed_http_4\d\d$/.test(c)) return "border-amber-200 bg-amber-50 text-amber-700";
  if (c === "soft_failure") return "border-amber-200 bg-amber-50 text-amber-700";
  if (c === "blocked" || c === "adapter_error" || c.startsWith("failed")) return "border-red-200 bg-red-50 text-red-700";
  if (c === "metadata_none" || c === "metadata_empty") return "border-amber-200 bg-amber-50 text-amber-700";
  if (c.startsWith("metadata")) return "border-slate-200 bg-slate-100 text-slate-600";
  return "border-border bg-secondary text-muted-foreground";
}

export function formatDuration(ms: number | null): string {
  if (ms == null || Number.isNaN(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Duration between started_at and finished_at (or null if still running). */
export function runDurationMs(startedAt: string, finishedAt: string | null): number | null {
  if (!finishedAt) return null;
  const d = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return Number.isNaN(d) ? null : d;
}
