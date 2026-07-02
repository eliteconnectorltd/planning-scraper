import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { ArrowUpRight, AlertTriangle } from "lucide-react";
import { fetchRuns, fetchRunHealthToday } from "@/lib/planning-api";
import { Loading } from "@/components/loading";
import { chip, statusChipClass, formatDuration, runDurationMs } from "@/lib/run-format";
import type { ScrapeRunStatus } from "@/lib/types";

const PAGE_SIZE = 25;
const STATUSES: ScrapeRunStatus[] = ["running", "completed", "partial", "failed", "aborted"];
const RANGES = [
  { label: "Last 24h", value: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "Last 7d", value: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "Last 30d", value: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { label: "All time", value: "all", ms: 0 },
];

function relative(ts: string) {
  try { return formatDistanceToNow(new Date(ts), { addSuffix: true }); }
  catch { return ts; }
}

function HealthCard() {
  const { data } = useQuery({ queryKey: ["run-health-today"], queryFn: fetchRunHealthToday });
  const tiles = [
    { label: "Runs today", value: data?.total ?? 0, cls: "text-foreground" },
    { label: "Succeeded", value: data?.completed ?? 0, cls: "text-green-700" },
    { label: "Failed", value: (data?.failed ?? 0) + (data?.aborted ?? 0), cls: "text-red-700" },
    { label: "Avg duration", value: formatDuration(data?.avgDurationMs ?? null), cls: "text-foreground" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map(t => (
        <div key={t.label} className="card-surface p-3">
          <div className={`text-lg font-semibold tabular-nums ${t.cls}`}>{t.value}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{t.label}</div>
        </div>
      ))}
    </div>
  );
}

export default function Runs() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<ScrapeRunStatus | "All">("All");
  const [range, setRange] = useState("7d");
  const [page, setPage] = useState(0);

  const since = (() => {
    const r = RANGES.find(x => x.value === range);
    return r && r.ms > 0 ? new Date(Date.now() - r.ms).toISOString() : null;
  })();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["runs", { status, range, page }],
    queryFn: () => fetchRuns({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      status: status !== "All" ? status : null,
      since,
    }),
    placeholderData: keepPreviousData,
  });

  const runs = data?.data ?? [];
  const total = data?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1 className="page-title">Runs</h1>
          <p className="page-description">Scraper invocations — status, counters, and per-run event logs.</p>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{total}</span>
          <span>runs</span>
        </div>
      </header>

      <HealthCard />

      <section className="card-surface flex flex-wrap items-center gap-2 p-3">
        <select value={status} onChange={e => { setStatus(e.target.value as ScrapeRunStatus | "All"); setPage(0); }} className="form-control" aria-label="Status filter">
          <option value="All">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
        <select value={range} onChange={e => { setRange(e.target.value); setPage(0); }} className="form-control" aria-label="Date range filter">
          {RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </section>

      {isLoading ? (
        <Loading />
      ) : isError ? (
        <div className="card-surface p-6 text-sm text-red-700">Failed to load runs: {(error as Error).message}</div>
      ) : runs.length === 0 ? (
        <div className="card-surface flex min-h-[240px] flex-col items-center justify-center p-8 text-center">
          <h2 className="text-base font-semibold text-foreground">No runs found</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">No scraper runs match these filters. Runs appear here after the scraper executes.</p>
        </div>
      ) : (
        <>
          <div className="card-surface overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Started</th>
                    <th className="px-4 py-2.5 font-medium">Duration</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Trigger</th>
                    <th className="px-4 py-2.5 font-medium">Councils</th>
                    <th className="px-4 py-2.5 font-medium">Applications</th>
                    <th className="px-4 py-2.5 text-right font-medium">Docs (new / total)</th>
                    <th className="px-4 py-2.5 text-right font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map(run => {
                    const href = `/runs/${run.id}`;
                    const councilFail = run.councils_failed > 0;
                    const appFail = run.applications_scraped_failed > 0;
                    const skipped = run.applications_skipped_terminal + run.applications_skipped_filter + run.applications_skipped_no_docs;
                    return (
                      <tr key={run.id} onClick={() => navigate(href)} className="group cursor-pointer border-b border-border last:border-0 transition-colors hover:bg-secondary/70">
                        <td className="px-4 py-3 align-top whitespace-nowrap">
                          <Link to={href} onClick={e => e.stopPropagation()} className="font-medium text-primary hover:underline">{relative(run.started_at)}</Link>
                          <div className="mt-0.5 text-xs text-muted-foreground">{new Date(run.started_at).toLocaleString()}</div>
                        </td>
                        <td className="px-4 py-3 align-top whitespace-nowrap tabular-nums text-muted-foreground">
                          {run.status === "running" ? <span className="text-blue-700">running</span> : formatDuration(runDurationMs(run.started_at, run.finished_at))}
                        </td>
                        <td className="px-4 py-3 align-top"><span className={`${chip} ${statusChipClass(run.status)}`}>{run.status}</span></td>
                        <td className="px-4 py-3 align-top"><span className={`${chip} border-border bg-secondary text-muted-foreground`}>{run.trigger}</span></td>
                        <td className={`px-4 py-3 align-top tabular-nums ${councilFail ? "text-red-700" : "text-muted-foreground"}`}>
                          {run.councils_succeeded}/{run.councils_attempted}
                        </td>
                        <td className={`px-4 py-3 align-top tabular-nums ${appFail ? "text-red-700" : "text-muted-foreground"}`}
                            title={`ok ${run.applications_scraped_ok} · failed ${run.applications_scraped_failed} · skipped ${skipped} (terminal ${run.applications_skipped_terminal}, filter ${run.applications_skipped_filter}, no-docs ${run.applications_skipped_no_docs})`}>
                          {run.applications_scraped_ok}/{run.applications_seen}
                          {skipped > 0 && <span className="ml-1 text-xs text-muted-foreground">(+{skipped} skipped)</span>}
                        </td>
                        {(() => {
                          const totalDocs = run.documents_downloaded + run.documents_skipped_known + run.documents_failed;
                          const hasFail = run.documents_failed > 0;
                          return (
                            <td className={`px-4 py-3 align-top text-right tabular-nums ${hasFail ? "text-red-700" : "text-muted-foreground"}`}
                                title={`${run.documents_downloaded} new, ${run.documents_skipped_known} already stored, ${run.documents_failed} failed`}>
                              <span className="inline-flex items-center justify-end gap-1">
                                {hasFail && <AlertTriangle className="h-3.5 w-3.5" />}
                                {run.documents_downloaded} / {totalDocs}
                              </span>
                            </td>
                          );
                        })()}
                        <td className="px-4 py-3 align-top text-right"><ArrowUpRight className="ml-auto h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Page {page + 1} of {pageCount}</span>
            <div className="flex gap-2">
              <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}
                className="rounded-md border border-border bg-card px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-40">Previous</button>
              <button disabled={page + 1 >= pageCount} onClick={() => setPage(p => p + 1)}
                className="rounded-md border border-border bg-card px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-40">Next</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
