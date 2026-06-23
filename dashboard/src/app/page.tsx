import { getApplicationsPage, getChangeFeed } from "@/lib/supabase-api";
import { Activity, ArrowUpRight, Building2, CheckCircle2, FileSearch, FileText, Layers3, RadioTower, Sparkles } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

function Sparkline({ tone = "cyan" }: { tone?: "cyan" | "violet" | "emerald" | "amber" }) {
  const color = {
    cyan: "stroke-cyan-300",
    violet: "stroke-violet-300",
    emerald: "stroke-emerald-300",
    amber: "stroke-amber-300",
  }[tone];

  return (
    <svg viewBox="0 0 120 34" className="h-9 w-28 overflow-visible" aria-hidden="true">
      <defs>
        <linearGradient id={`spark-${tone}`} x1="0" x2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity=".1" />
          <stop offset="100%" stopColor="currentColor" stopOpacity=".55" />
        </linearGradient>
      </defs>
      <path d="M2 27 C 14 25, 16 10, 28 15 S 45 28, 58 16 S 80 6, 92 14 S 105 28, 118 8" className={`${color} fill-none`} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-GB").format(value || 0);
}

export default async function Home() {
  const [{ data: records, count }, { data: changeLog }] = await Promise.all([
    getApplicationsPage({ page: 1, pageSize: 100 }),
    getChangeFeed({ page: 1, pageSize: 100 }),
  ]);

  const totalApplications = count || records.length;
  const totalDocuments = records.reduce((acc, record) => acc + (record.documents?.length || 0), 0);
  const councils = new Set(records.map(record => record.council).filter(Boolean)).size;
  const decisionsThisWeek = records.filter(record => record.decision_date).length;
  const timelineEvents = records.reduce((acc, record) => acc + (record.timeline?.length || 0), 0);
  const latestChanges = changeLog[0]; // getChangeFeed returns newest-first
  const newDocs = latestChanges?.summary.new_documents || 0;
  const newApps = latestChanges?.summary.new_applications || 0;
  const changeEvents = latestChanges
    ? Object.values(latestChanges.summary).reduce((total, value) => total + value, 0)
    : 0;

  const kpis = [
    { label: "Applications Tracked", value: totalApplications, trend: "+12.4%", icon: FileSearch, tone: "cyan" as const },
    { label: "Documents Indexed", value: totalDocuments, trend: "+18.8%", icon: Layers3, tone: "violet" as const },
    { label: "Decisions This Week", value: decisionsThisWeek, trend: "+4.1%", icon: CheckCircle2, tone: "emerald" as const },
    { label: "Active Councils", value: councils, trend: "Live", icon: Building2, tone: "amber" as const },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-8 px-5 py-6 sm:px-8 lg:px-10">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-medium text-cyan-200">
            <RadioTower className="h-3.5 w-3.5" />
            Live planning intelligence
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">Platform Overview</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
            Real-time planning applications, document intelligence, and portal change signals across tracked councils.
          </p>
        </div>
        <Link href="/applications" className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-4 py-2 text-sm font-medium text-white shadow-lg shadow-black/20 transition hover:border-cyan-300/40 hover:bg-cyan-300/10">
          Explore applications
          <ArrowUpRight className="h-4 w-4" />
        </Link>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {kpis.map(kpi => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="premium-card p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="rounded-lg border border-white/10 bg-white/[0.05] p-2.5">
                  <Icon className="h-5 w-5 text-cyan-200" />
                </div>
                <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-xs font-medium text-emerald-200">{kpi.trend}</span>
              </div>
              <div className="mt-6 flex items-end justify-between gap-4">
                <div>
                  <div className="text-3xl font-semibold tracking-tight text-white">{formatNumber(kpi.value)}</div>
                  <div className="mt-1 text-sm text-slate-400">{kpi.label}</div>
                </div>
                <Sparkline tone={kpi.tone} />
              </div>
            </div>
          );
        })}
      </section>

      <section className="glass-panel relative overflow-hidden rounded-xl p-6 sm:p-8">
        <div className="absolute inset-0 bg-[linear-gradient(115deg,rgba(34,211,238,.16),rgba(99,102,241,.12)_45%,rgba(168,85,247,.16))]" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent" />
        <div className="relative grid gap-8 lg:grid-cols-[1.25fr_.75fr] lg:items-center">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-cyan-100">
              <Sparkles className="h-3.5 w-3.5" />
              Intelligence layer active
            </div>
            <h2 className="max-w-3xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Coverage graph is indexing applications, documents, and timeline events into one operational view.
            </h2>
            <div className="mt-7 grid gap-3 sm:grid-cols-4">
              {[
                ["Total Coverage", `${formatNumber(totalApplications)} apps`],
                ["New Applications Today", formatNumber(newApps)],
                ["New Documents", formatNumber(newDocs)],
                ["Change Events", formatNumber(changeEvents || timelineEvents)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-white/10 bg-slate-950/35 p-4 backdrop-blur-xl">
                  <div className="text-2xl font-semibold text-white">{value}</div>
                  <div className="mt-1 text-xs uppercase tracking-wide text-slate-400">{label}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-950/40 p-5 shadow-2xl shadow-black/20">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-white">Signal Quality</div>
                <div className="text-xs text-slate-500">Extraction health snapshot</div>
              </div>
              <Activity className="h-5 w-5 text-cyan-300" />
            </div>
            <div className="space-y-4">
              {[
                ["Portal coverage", 86, "bg-cyan-300"],
                ["Document freshness", 74, "bg-violet-300"],
                ["Decision enrichment", 62, "bg-emerald-300"],
              ].map(([label, value, color]) => (
                <div key={label as string}>
                  <div className="mb-2 flex justify-between text-xs">
                    <span className="text-slate-400">{label}</span>
                    <span className="font-medium text-white">{value}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/10">
                    <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="premium-card lg:col-span-2">
          <div className="border-b border-white/10 p-5">
            <h3 className="text-base font-semibold text-white">Recent Intelligence Feed</h3>
            <p className="mt-1 text-sm text-slate-500">Latest platform-level movements and extracted signals.</p>
          </div>
          <div className="divide-y divide-white/10">
            {[
              ["New applications", latestChanges?.summary.new_applications || records.length, "Applications captured from extractable locations"],
              ["Documents indexed", latestChanges?.summary.new_documents || totalDocuments, "Stored in Supabase and linked to planning records"],
              ["Timeline events", timelineEvents, "Council dates and document additions normalized"],
            ].map(([title, value, description]) => (
              <div key={title as string} className="flex items-center justify-between gap-4 p-5">
                <div>
                  <div className="font-medium text-white">{title}</div>
                  <div className="mt-1 text-sm text-slate-500">{description}</div>
                </div>
                <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-sm font-semibold text-cyan-100">{formatNumber(Number(value))}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="premium-card p-5">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-white">Operating Coverage</h3>
              <p className="mt-1 text-sm text-slate-500">Council distribution</p>
            </div>
            <FileText className="h-5 w-5 text-violet-300" />
          </div>
          <div className="space-y-3">
            {Array.from(new Set(records.map(record => record.council).filter(Boolean))).slice(0, 6).map(council => {
              const countForCouncil = records.filter(record => record.council === council).length;
              return (
                <div key={council} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2">
                  <span className="truncate text-sm text-slate-300">{council}</span>
                  <span className="text-sm font-semibold text-white">{countForCouncil}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
