import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, ChevronRight, Download } from "lucide-react";
import { fetchRun, fetchRunEvents } from "@/lib/planning-api";
import { Loading } from "@/components/loading";
import { chip, statusChipClass, levelChipClass, reasonCodeColor, formatDuration, runDurationMs } from "@/lib/run-format";
import type { ScrapeEvent } from "@/lib/types";

const RENDER_CAP = 500; // no virtualization dep available — cap rendered rows, guide via filters

// Labeled fields surfaced ABOVE the raw JSON when expanded (order matters).
const LABELED_FIELDS: Array<{ key: string; label: string }> = [
  { key: "reason_message", label: "Reason" },
  { key: "error_message", label: "Error message" },
  { key: "http_status", label: "HTTP status" },
  { key: "bytes", label: "Bytes" },
  { key: "storage_path", label: "Storage path" },
  { key: "duration_ms", label: "Duration (ms)" },
  { key: "error_stack", label: "Error stack" },
];

function reasonCodeOf(ev: ScrapeEvent): string | null {
  const d = ev.details as Record<string, unknown> | null;
  const rc = d && typeof d.reason_code === "string" ? d.reason_code : null;
  return rc || null;
}

function StatTile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className={`text-base font-semibold tabular-nums ${tone || "text-foreground"}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function EventRow({ ev }: { ev: ScrapeEvent }) {
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const details = ev.details as Record<string, unknown> | null;
  const hasDetails = details && Object.keys(details).length > 0;
  const reasonCode = reasonCodeOf(ev);
  const labeled = LABELED_FIELDS.filter(f => details && details[f.key] != null && String(details[f.key]).trim() !== "");

  return (
    <div className="border-b border-border last:border-0">
      <button onClick={() => hasDetails && setOpen(o => !o)} className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm ${hasDetails ? "cursor-pointer hover:bg-secondary/60" : "cursor-default"}`}>
        <span className="mt-0.5 w-4 shrink-0 text-muted-foreground">{hasDetails ? (open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />) : null}</span>
        <span className="w-[128px] shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground">{new Date(ev.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
        <span className={`${chip} ${levelChipClass(ev.level)} shrink-0`}>{ev.level}</span>
        <span className="w-[150px] shrink-0 truncate font-mono text-xs text-foreground" title={ev.stage}>{ev.stage}</span>
        <span className="w-[90px] shrink-0 truncate text-xs text-muted-foreground" title={ev.council || ""}>{ev.council || "—"}</span>
        <span className="w-[120px] shrink-0 truncate text-xs text-muted-foreground" title={ev.application_uid || ""}>{ev.application_uid || ""}</span>
        <span className="min-w-0 flex-1 break-words text-foreground">{ev.message}{ev.duration_ms != null && <span className="ml-2 text-xs text-muted-foreground">{formatDuration(ev.duration_ms)}</span>}</span>
        {reasonCode && <span className={`${chip} ${reasonCodeColor(reasonCode)} ml-2 shrink-0`} title="reason_code">{reasonCode}</span>}
      </button>
      {open && hasDetails && (
        <div className="mx-3 mb-2 space-y-2">
          {labeled.length > 0 && (
            <dl className="grid gap-x-4 gap-y-1 rounded-md border border-border bg-background p-3 text-xs sm:grid-cols-[140px_1fr]">
              {labeled.map(f => (
                <div key={f.key} className="contents">
                  <dt className="font-medium text-muted-foreground">{f.label}</dt>
                  <dd className={`min-w-0 break-words ${f.key === "error_stack" ? "whitespace-pre-wrap font-mono text-[11px] text-muted-foreground" : "text-foreground"}`}>{String(details![f.key])}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="rounded-md border border-border bg-secondary/40">
            <button onClick={() => setShowRaw(s => !s)} className="flex w-full items-center gap-1 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
              {showRaw ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Raw JSON
            </button>
            {showRaw && <pre className="overflow-x-auto px-3 pb-3 text-xs text-muted-foreground">{JSON.stringify(ev.details, null, 2)}</pre>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RunDetail() {
  const { id = "" } = useParams();
  const [showConfig, setShowConfig] = useState(false);
  const [fLevel, setFLevel] = useState("All");
  const [fStage, setFStage] = useState("All");
  const [fCouncil, setFCouncil] = useState("All");
  const [fReason, setFReason] = useState("All");
  const [search, setSearch] = useState("");
  const [desc, setDesc] = useState(true);

  const runQ = useQuery({ queryKey: ["run", id], queryFn: () => fetchRun(id), enabled: Boolean(id) });
  // Fetch all events once (unfiltered) → breakdown, dropdown options and timeline
  // are derived client-side so filtering is instant and the council roll-up stays correct.
  const evQ = useQuery({ queryKey: ["run-events", id], queryFn: () => fetchRunEvents(id), enabled: Boolean(id) });

  const events = useMemo(() => evQ.data ?? [], [evQ.data]);
  const stages = useMemo(() => Array.from(new Set(events.map(e => e.stage))).sort(), [events]);
  const councils = useMemo(() => Array.from(new Set(events.map(e => e.council).filter(Boolean))) as string[], [events]);
  const reasons = useMemo(() => Array.from(new Set(events.map(reasonCodeOf).filter(Boolean))).sort() as string[], [events]);

  const councilBreakdown = useMemo(() => {
    const map = new Map<string, { ok: number; failed: number; terminal: number; filtered: number; docs: number; errors: number }>();
    for (const e of events) {
      const c = e.council || "—";
      if (!map.has(c)) map.set(c, { ok: 0, failed: 0, terminal: 0, filtered: 0, docs: 0, errors: 0 });
      const s = map.get(c)!;
      if (e.stage === "application_finish") { if (e.level === "error") s.failed++; else s.ok++; }
      if (e.stage === "terminal_skip") s.terminal++;
      if (e.stage === "postcode_skip") s.filtered++;
      if (e.stage === "document_download" && e.message.startsWith("Document downloaded")) s.docs++;
      if (e.level === "error") s.errors++;
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [events]);

  const errorCount = useMemo(() => events.filter(e => e.level === "error").length, [events]);

  const filtered = useMemo(() => {
    let list = events.filter(e =>
      (fLevel === "All" || e.level === fLevel) &&
      (fStage === "All" || e.stage === fStage) &&
      (fCouncil === "All" || (e.council || "—") === fCouncil) &&
      (fReason === "All" || reasonCodeOf(e) === fReason) &&
      (!search || e.message.toLowerCase().includes(search.toLowerCase()))
    );
    list = desc ? [...list].reverse() : list;
    return list;
  }, [events, fLevel, fStage, fCouncil, fReason, search, desc]);

  function exportJson() {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `run-${id}-events.json`; a.click();
    URL.revokeObjectURL(url);
  }

  if (runQ.isLoading) return <Loading />;
  if (runQ.isError) return <div className="page-container"><div className="card-surface p-6 text-sm text-red-700">Failed to load run: {(runQ.error as Error).message}</div></div>;
  const run = runQ.data;
  if (!run) return <div className="page-container"><div className="card-surface p-6 text-sm text-muted-foreground">Run not found. <Link to="/runs" className="text-primary hover:underline">Back to runs</Link></div></div>;

  return (
    <div className="page-container">
      <Link to="/runs" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> All runs</Link>

      {/* Section 1: Summary */}
      <section className="card-surface p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`${chip} ${statusChipClass(run.status)}`}>{run.status}</span>
          <span className={`${chip} border-border bg-secondary text-muted-foreground`}>{run.trigger}</span>
          <span className="font-mono text-xs text-muted-foreground">{run.id}</span>
        </div>
        <div className="mt-3 grid gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
          <div>Started: <span className="text-foreground">{new Date(run.started_at).toLocaleString()}</span></div>
          <div>Finished: <span className="text-foreground">{run.finished_at ? new Date(run.finished_at).toLocaleString() : "—"}</span></div>
          <div>Duration: <span className="text-foreground">{run.status === "running" ? "running" : formatDuration(runDurationMs(run.started_at, run.finished_at))}</span></div>
          <div>Host: <span className="text-foreground">{run.hostname || "—"}</span></div>
          <div>Version: <span className="text-foreground">{run.scraper_version || "—"}</span></div>
          <div>Errors: <span className={errorCount > 0 ? "text-red-700" : "text-foreground"}>{errorCount}</span></div>
        </div>

        {run.error_summary && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{run.error_summary}</div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label="Councils ok/att" value={`${run.councils_succeeded}/${run.councils_attempted}`} tone={run.councils_failed > 0 ? "text-red-700" : undefined} />
          <StatTile label="Apps seen" value={run.applications_seen} />
          <StatTile label="Apps ok" value={run.applications_scraped_ok} tone="text-green-700" />
          <StatTile label="Apps failed" value={run.applications_scraped_failed} tone={run.applications_scraped_failed > 0 ? "text-red-700" : undefined} />
          <StatTile label="Skipped (term/filt/nodoc)" value={`${run.applications_skipped_terminal}/${run.applications_skipped_filter}/${run.applications_skipped_no_docs}`} />
          <StatTile label="Docs dl/known/fail" value={`${run.documents_downloaded}/${run.documents_skipped_known}/${run.documents_failed}`} tone={run.documents_failed > 0 ? "text-red-700" : undefined} />
        </div>

        {run.config_snapshot && (
          <div className="mt-3">
            <button onClick={() => setShowConfig(s => !s)} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
              {showConfig ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Config snapshot
            </button>
            {showConfig && <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">{JSON.stringify(run.config_snapshot, null, 2)}</pre>}
          </div>
        )}
      </section>

      {/* Section 2: Council breakdown */}
      {councilBreakdown.length > 0 && (
        <section className="card-surface p-4">
          <h2 className="text-sm font-semibold text-foreground">Council breakdown</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {councilBreakdown.map(([council, s]) => (
              <button key={council} onClick={() => setFCouncil(council)}
                className={`rounded-md border px-3 py-2 text-left text-xs transition-colors hover:bg-secondary ${fCouncil === council ? "border-border-strong bg-secondary" : "border-border bg-background"}`}>
                <div className="font-medium text-foreground">{council}</div>
                <div className="mt-0.5 text-muted-foreground">
                  ok {s.ok} · fail {s.failed} · term {s.terminal} · filt {s.filtered} · docs {s.docs}
                  {s.errors > 0 && <span className="text-red-700"> · err {s.errors}</span>}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Section 3: Event timeline */}
      <section className="card-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <select value={fLevel} onChange={e => setFLevel(e.target.value)} className="form-control" aria-label="Level filter">
            <option value="All">All levels</option>
            {["info", "warn", "error", "debug"].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <select value={fStage} onChange={e => setFStage(e.target.value)} className="form-control" aria-label="Stage filter">
            <option value="All">All stages</option>
            {stages.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={fCouncil} onChange={e => setFCouncil(e.target.value)} className="form-control" aria-label="Council filter">
            <option value="All">All councils</option>
            {councils.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {reasons.length > 0 && (
            <select value={fReason} onChange={e => setFReason(e.target.value)} className="form-control" aria-label="Reason filter">
              <option value="All">All reasons</option>
              {reasons.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search message…" className="form-control min-w-[160px] flex-1" aria-label="Search messages" />
          <button onClick={() => setDesc(d => !d)} className="rounded-md border border-border bg-card px-2.5 py-2 text-xs font-medium text-foreground hover:bg-secondary">{desc ? "Newest first" : "Oldest first"}</button>
          <button onClick={exportJson} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-2 text-xs font-medium text-foreground hover:bg-secondary"><Download className="h-3.5 w-3.5" /> Export</button>
        </div>

        {evQ.isLoading ? (
          <div className="p-6"><Loading /></div>
        ) : evQ.isError ? (
          <div className="p-6 text-sm text-red-700">Failed to load events: {(evQ.error as Error).message}</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No events match these filters.</div>
        ) : (
          <>
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {filtered.length} event{filtered.length === 1 ? "" : "s"}
              {filtered.length > RENDER_CAP && <span> — showing first {RENDER_CAP}; refine filters to narrow.</span>}
            </div>
            <div>
              {filtered.slice(0, RENDER_CAP).map(ev => <EventRow key={ev.id} ev={ev} />)}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
