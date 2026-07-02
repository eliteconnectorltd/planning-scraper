import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowUpRight, CalendarDays, FileText, MapPin, Search, X } from "lucide-react";
import { getApplicationsPage } from "@/lib/planning-api";
import { Loading } from "@/components/loading";

function statusClass(status?: string | null) {
  const value = String(status || "PENDING").toUpperCase();
  if (value.includes("GRANT") || value.includes("APPROV") || value.includes("PERMIT")) {
    return "border-green-200 bg-green-50 text-green-700";
  }
  if (value.includes("REFUS")) {
    return "border-red-200 bg-red-50 text-red-700";
  }
  if (value.includes("WITHDRAW")) {
    return "border-slate-200 bg-slate-100 text-slate-600";
  }
  if (value.includes("FINAL DECISION") || value.includes("DECISION")) {
    return "border-blue-200 bg-blue-50 text-blue-700";
  }
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function cleanStatus(status?: string | null) {
  if (!status || status === "PENDING") return "Pending";
  return status.toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

const chip = "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium";

export default function Applications() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") || "";
  const council = searchParams.get("council") || "All";
  const decision = searchParams.get("decision") || "All";
  const minDocs = Number(searchParams.get("minDocs") || 0) || 0;
  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const next: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      const text = String(value);
      if (text && text !== "All" && !(key === "minDocs" && text === "0")) next[key] = text;
    }
    setSearchParams(next);
  }

  const { data: result, isLoading } = useQuery({
    queryKey: ["applications", { q, council, decision }],
    queryFn: () => getApplicationsPage({
      page: 1,
      pageSize: 100,
      q: q || undefined,
      council: council !== "All" ? council : undefined,
      decision: decision !== "All" ? decision : undefined,
    }),
  });

  if (isLoading) return <Loading />;
  const data = result?.data ?? [];

  const filtered = data.filter(app => {
    if (minDocs > 0 && (app.documents?.length || 0) < minDocs) return false;
    const latest = app.timeline?.at(-1)?.date || app.updated_at;
    if (from && latest && new Date(latest) < new Date(from)) return false;
    if (to && latest && new Date(latest) > new Date(`${to}T23:59:59`)) return false;
    return true;
  });

  const councils = Array.from(new Set(data.map(record => record.council).filter(Boolean))).sort();
  const decisions = Array.from(new Set(data.map(record => record.decision || "PENDING"))).sort();
  const activeFilters = [
    q && { label: "Search", value: q },
    council !== "All" && { label: "Council", value: council },
    decision !== "All" && { label: "Decision", value: cleanStatus(decision) },
    minDocs > 0 && { label: "Docs", value: `${minDocs}+` },
    from && { label: "From", value: formatDate(from) },
    to && { label: "To", value: formatDate(to) },
  ].filter(Boolean) as Array<{ label: string; value: string }>;
  const hasActiveFilters = activeFilters.length > 0;

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1 className="page-title">Applications</h1>
          <p className="page-description">
            Search and inspect planning applications, source portals, documents, and timelines.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <span className="font-semibold text-foreground">{filtered.length}</span>
          <span>of {data.length} records</span>
        </div>
      </header>

      <section className="card-surface">
        <form onSubmit={handleSubmit} className="grid gap-3 p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-2 xl:grid-cols-[minmax(260px,1fr)_180px_180px_120px_150px_150px_auto] xl:items-center">
          <label className="relative sm:col-span-2 xl:col-span-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              name="q"
              defaultValue={q}
              placeholder="Search reference, address, proposal..."
              className="form-control w-full pl-9"
            />
          </label>

          <select name="council" defaultValue={council} className="form-control w-full" aria-label="Council">
            <option value="All">All councils</option>
            {councils.map(item => <option key={item} value={item}>{item}</option>)}
          </select>

          <select name="decision" defaultValue={decision} className="form-control w-full" aria-label="Decision">
            <option value="All">All decisions</option>
            {decisions.map(item => <option key={item} value={item}>{cleanStatus(item)}</option>)}
          </select>

          <select name="minDocs" defaultValue={String(minDocs)} className="form-control w-full" aria-label="Minimum documents">
            <option value="0">Any docs</option>
            <option value="1">1+ docs</option>
            <option value="5">5+ docs</option>
            <option value="10">10+ docs</option>
          </select>

          <input name="from" type="date" defaultValue={from} className="form-control w-full" aria-label="From date" />
          <input name="to" type="date" defaultValue={to} className="form-control w-full" aria-label="To date" />

          <button type="submit" className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-[0_1px_2px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1d4ed8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:col-span-2 xl:col-span-1">
            Search
          </button>
        </form>

        {hasActiveFilters && (
          <div className="flex flex-col gap-3 border-t border-border bg-secondary/35 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
            <div className="flex flex-wrap gap-2">
              {activeFilters.map(filter => (
                <span key={`${filter.label}-${filter.value}`} className={`${chip} border-border bg-card text-muted-foreground`}>
                  <span className="mr-1 text-foreground">{filter.label}</span>
                  {filter.value}
                </span>
              ))}
            </div>
            <button type="button" onClick={() => setSearchParams({})} className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground transition-colors hover:border-border-strong hover:bg-secondary">
              <X className="h-3.5 w-3.5 text-muted-foreground" />
              Clear filters
            </button>
          </div>
        )}
      </section>

      {filtered.length === 0 ? (
        <div className="card-surface flex min-h-[280px] flex-col items-center justify-center p-8 text-center sm:p-10">
          <h2 className="text-base font-semibold text-foreground">No matching applications</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">Relax the filters or search a broader reference, council, address, or proposal.</p>
          {hasActiveFilters && (
            <button type="button" onClick={() => setSearchParams({})} className="mt-4 inline-flex h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary">
              Clear all filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="hidden card-surface overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Reference</th>
                    <th className="px-4 py-2.5 font-medium">Proposal</th>
                    <th className="px-4 py-2.5 font-medium">Council</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium">Docs</th>
                    <th className="px-4 py-2.5 font-medium">Updated</th>
                    <th className="px-4 py-2.5 text-right font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(app => {
                    const latest = app.timeline?.at(-1)?.date || app.updated_at;
                    const href = `/applications/${encodeURIComponent(app.application_id || app.title || "")}`;
                    return (
                      <tr
                        key={app.application_id || app.title}
                        onClick={() => navigate(href)}
                        className="group cursor-pointer border-b border-border last:border-0 transition-colors hover:bg-secondary/70"
                      >
                        <td className="px-4 py-3 align-top">
                          <Link to={href} onClick={event => event.stopPropagation()} className="font-medium text-primary hover:underline">
                            {app.application_id || "-"}
                          </Link>
                        </td>
                        <td className="max-w-[420px] px-4 py-3 align-top">
                          <span className="line-clamp-2 text-foreground">{app.proposal || "No proposal captured"}</span>
                          {app.address && <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{app.address}</span>}
                        </td>
                        <td className="px-4 py-3 align-top text-muted-foreground">{app.council || "-"}</td>
                        <td className="px-4 py-3 align-top">
                          <span className={`${chip} ${statusClass(app.status || app.decision)}`}>
                            {cleanStatus(app.status || app.decision)}
                          </span>
                        </td>
                        <td className="px-4 py-3 align-top text-right tabular-nums text-muted-foreground">{app.documents?.length || 0}</td>
                        <td className="px-4 py-3 align-top whitespace-nowrap text-muted-foreground">{formatDate(latest)}</td>
                        <td className="px-4 py-3 align-top text-right">
                          <ArrowUpRight className="ml-auto h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid gap-3 md:hidden">
            {filtered.map(app => {
              const latest = app.timeline?.at(-1)?.date || app.updated_at;
              const href = `/applications/${encodeURIComponent(app.application_id || app.title || "")}`;
              return (
                <Link key={app.application_id || app.title} to={href} className="table-card-row">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-primary">{app.application_id || "Unknown reference"}</div>
                      <p className="mt-1 line-clamp-3 text-sm leading-6 text-foreground">{app.proposal || "No proposal captured"}</p>
                    </div>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className={`${chip} ${statusClass(app.status || app.decision)}`}>{cleanStatus(app.status || app.decision)}</span>
                    <span className={`${chip} border-border bg-secondary text-muted-foreground`}>{app.council || "Unknown council"}</span>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-muted-foreground">
                    <span className="flex min-w-0 items-center gap-2">
                      <MapPin className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{app.address || "No address captured"}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5" />
                      {app.documents?.length || 0} documents
                    </span>
                    <span className="flex items-center gap-2">
                      <CalendarDays className="h-3.5 w-3.5" />
                      Updated {formatDate(latest)}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
