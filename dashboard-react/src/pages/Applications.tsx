import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
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
  if (value.includes("REGISTERED")) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-amber-200 bg-amber-50 text-amber-700"; // default: pending-like
}

function cleanStatus(status?: string | null) {
  if (!status || status === "PENDING") return "Pending";
  return status.toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

const inputClass = "h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none transition-colors focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/30";

export default function Applications() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") || "";
  const council = searchParams.get("council") || "All";
  const decision = searchParams.get("decision") || "All";
  const minDocs = Number(searchParams.get("minDocs") || 0) || 0;
  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";

  // The old page was a native <form> GET that Next read via searchParams. In the
  // SPA the form submit updates the URL query string client-side (no full reload).
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const next: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      const text = String(value);
      if (text) next[key] = text;
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

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Applications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Search and inspect planning applications, their source portals, documents, and timelines.
          </p>
        </div>
        <div className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{filtered.length}</span> records
        </div>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            name="q"
            defaultValue={q}
            placeholder="Search reference, address, proposal…"
            className={`${inputClass} w-full pl-8`}
          />
        </label>

        <select name="council" defaultValue={council} className={inputClass} aria-label="Council">
          <option value="All">All councils</option>
          {councils.map(item => <option key={item} value={item}>{item}</option>)}
        </select>

        <select name="decision" defaultValue={decision} className={inputClass} aria-label="Decision">
          <option value="All">All decisions</option>
          {decisions.map(item => <option key={item} value={item}>{cleanStatus(item)}</option>)}
        </select>

        <select name="minDocs" defaultValue={String(minDocs)} className={inputClass} aria-label="Minimum documents">
          <option value="0">Any docs</option>
          <option value="1">1+ docs</option>
          <option value="5">5+ docs</option>
          <option value="10">10+ docs</option>
        </select>

        <input name="from" type="date" defaultValue={from} className={inputClass} aria-label="From date" />
        <input name="to" type="date" defaultValue={to} className={inputClass} aria-label="To date" />

        <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-[#1d4ed8] focus-visible:ring-2 focus-visible:ring-ring/40">
          Search
        </button>
      </form>

      {filtered.length === 0 ? (
        <div className="card-surface flex min-h-[280px] flex-col items-center justify-center p-10 text-center">
          <h2 className="text-base font-semibold text-foreground">No matching applications</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">Relax the filters or search a broader reference, council, address, or proposal.</p>
        </div>
      ) : (
        <div className="card-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Reference</th>
                  <th className="px-4 py-2.5 font-medium">Proposal</th>
                  <th className="px-4 py-2.5 font-medium">Council</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Docs</th>
                  <th className="px-4 py-2.5 font-medium">Updated</th>
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
                      className="cursor-pointer border-b border-border last:border-0 transition-colors hover:bg-secondary/60"
                    >
                      <td className="px-4 py-3 align-top">
                        <Link
                          to={href}
                          onClick={event => event.stopPropagation()}
                          className="font-medium text-primary hover:underline"
                        >
                          {app.application_id || "—"}
                        </Link>
                      </td>
                      <td className="max-w-[420px] px-4 py-3 align-top">
                        <span className="line-clamp-2 text-foreground">{app.proposal || "No proposal captured"}</span>
                        {app.address && <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{app.address}</span>}
                      </td>
                      <td className="px-4 py-3 align-top text-muted-foreground">{app.council || "—"}</td>
                      <td className="px-4 py-3 align-top">
                        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${statusClass(app.status || app.decision)}`}>
                          {cleanStatus(app.status || app.decision)}
                        </span>
                      </td>
                      <td className="px-4 py-3 align-top text-right tabular-nums text-muted-foreground">{app.documents?.length || 0}</td>
                      <td className="px-4 py-3 align-top whitespace-nowrap text-muted-foreground">{formatDate(latest)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
