import { getApplicationsPage } from "@/lib/supabase-api";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { ArrowUpRight, CalendarDays, Database, FileText, Filter, MapPin, Search, SlidersHorizontal } from "lucide-react";

export const dynamic = "force-dynamic";

function statusClass(decision?: string | null) {
  const value = String(decision || "PENDING").toUpperCase();
  if (value.includes("GRANT") || value.includes("APPROV")) return "border-emerald-400/25 bg-emerald-400/10 text-emerald-200";
  if (value.includes("REFUS")) return "border-red-400/25 bg-red-400/10 text-red-200";
  if (value.includes("WITHDRAW")) return "border-slate-400/25 bg-slate-400/10 text-slate-200";
  return "border-amber-400/25 bg-amber-400/10 text-amber-200";
}

function cleanStatus(decision?: string | null) {
  if (!decision || decision === "PENDING") return "Pending";
  return decision.toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

function formatDate(value?: string | null) {
  if (!value) return "Not captured";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not captured";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

export default async function ApplicationsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; council?: string; decision?: string; minDocs?: string; from?: string; to?: string }>
}) {
  const params = await searchParams;
  const q = params.q || "";
  const council = params.council || "All";
  const decision = params.decision || "All";
  const minDocs = Number(params.minDocs || 0) || 0;
  const from = params.from || "";
  const to = params.to || "";

  const { data } = await getApplicationsPage({
    page: 1,
    pageSize: 100,
    q: q || undefined,
    council: council !== "All" ? council : undefined,
    decision: decision !== "All" ? decision : undefined,
  });

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
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-7 px-5 py-6 sm:px-8 lg:px-10">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-violet-300/20 bg-violet-300/10 px-3 py-1 text-xs font-medium text-violet-200">
            <Database className="h-3.5 w-3.5" />
            Application graph
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">Applications</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
            Search, triage, and inspect planning applications with their source portals, documents, and timeline intelligence.
          </p>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/[0.045] px-4 py-3 text-sm text-slate-300">
          <span className="font-semibold text-white">{filtered.length}</span> records in view
        </div>
      </section>

      <section className="glass-panel rounded-xl p-4">
        <form className="grid gap-3 xl:grid-cols-[1.25fr_.75fr_.75fr_.55fr_.7fr_.7fr_auto]">
          <label className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              name="q"
              defaultValue={q}
              placeholder="Search records..."
              className="h-11 w-full rounded-lg border border-white/10 bg-slate-950/55 pl-10 pr-4 2xl:pr-16 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-300/40 focus:ring-4 focus:ring-cyan-300/10"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-slate-500 2xl:block">Ctrl K</span>
          </label>

          <select name="council" defaultValue={council} className="h-11 rounded-lg border border-white/10 bg-slate-950/55 px-3 text-sm text-slate-200 outline-none focus:border-cyan-300/40">
            <option value="All">All councils</option>
            {councils.map(item => <option key={item} value={item}>{item}</option>)}
          </select>

          <select name="decision" defaultValue={decision} className="h-11 rounded-lg border border-white/10 bg-slate-950/55 px-3 text-sm text-slate-200 outline-none focus:border-cyan-300/40">
            <option value="All">All decisions</option>
            {decisions.map(item => <option key={item} value={item}>{cleanStatus(item)}</option>)}
          </select>

          <select name="minDocs" defaultValue={String(minDocs)} className="h-11 rounded-lg border border-white/10 bg-slate-950/55 px-3 text-sm text-slate-200 outline-none focus:border-cyan-300/40">
            <option value="0">Any docs</option>
            <option value="1">1+ docs</option>
            <option value="5">5+ docs</option>
            <option value="10">10+ docs</option>
          </select>

          <input name="from" type="date" defaultValue={from} className="h-11 rounded-lg border border-white/10 bg-slate-950/55 px-3 text-sm text-slate-300 outline-none focus:border-cyan-300/40" />
          <input name="to" type="date" defaultValue={to} className="h-11 rounded-lg border border-white/10 bg-slate-950/55 px-3 text-sm text-slate-300 outline-none focus:border-cyan-300/40" />

          <button type="submit" className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-400 to-violet-500 px-4 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-500/20 transition hover:scale-[1.01]">
            <Filter className="h-4 w-4" />
            Search
          </button>
        </form>
      </section>

      {filtered.length === 0 ? (
        <section className="glass-panel flex min-h-[360px] flex-col items-center justify-center rounded-xl p-10 text-center">
          <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/10">
            <SlidersHorizontal className="h-7 w-7 text-cyan-200" />
          </div>
          <h2 className="text-xl font-semibold text-white">No matching applications</h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">Relax the filters or search a broader reference, council, address, or proposal phrase.</p>
        </section>
      ) : (
        <section className="grid gap-4">
          {filtered.map(app => {
            const latest = app.timeline?.at(-1)?.date || app.updated_at;
            return (
              <Link key={app.application_id || app.title} href={`/applications/${encodeURIComponent(app.application_id || app.title || "")}`} className="group premium-card block overflow-hidden">
                <div className="grid gap-5 p-5 lg:grid-cols-[1fr_260px]">
                  <div className="min-w-0">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <h2 className="text-xl font-semibold tracking-tight text-white transition group-hover:text-cyan-100">{app.application_id}</h2>
                      <Badge className={statusClass(app.decision)}>{cleanStatus(app.decision)}</Badge>
                      <Badge variant="outline" className="border-cyan-300/20 bg-cyan-300/10 text-cyan-100">{app.council || "Unknown council"}</Badge>
                      <Badge variant="outline" className="border-violet-300/20 bg-violet-300/10 text-violet-100">{app.platform || "Unknown platform"}</Badge>
                    </div>
                    <p className="line-clamp-2 text-base font-medium leading-7 text-slate-100">{app.proposal || "No proposal captured"}</p>
                    <div className="mt-4 flex flex-wrap gap-4 text-sm text-slate-500">
                      <span className="inline-flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-slate-600" />
                        {app.address || "No address captured"}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 border-t border-white/10 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
                    <div className="rounded-lg border border-white/10 bg-white/[0.035] p-3">
                      <FileText className="mb-2 h-4 w-4 text-cyan-300" />
                      <div className="text-lg font-semibold text-white">{app.documents?.length || 0}</div>
                      <div className="text-xs text-slate-500">Documents</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-white/[0.035] p-3">
                      <CalendarDays className="mb-2 h-4 w-4 text-violet-300" />
                      <div className="text-sm font-semibold text-white">{formatDate(latest)}</div>
                      <div className="text-xs text-slate-500">Last updated</div>
                    </div>
                    <div className="col-span-2 flex items-center justify-between rounded-lg border border-white/10 bg-slate-950/35 px-3 py-2 text-sm">
                      <span className="text-slate-400">Quick inspect</span>
                      <ArrowUpRight className="h-4 w-4 text-cyan-300 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </section>
      )}
    </div>
  );
}
