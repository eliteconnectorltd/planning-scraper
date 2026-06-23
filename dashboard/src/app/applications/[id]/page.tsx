import { getApplicationDetail } from "@/lib/supabase-api";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SourceActions } from "@/components/source-actions";
import {
  Activity,
  ArrowUpRight,
  BrainCircuit,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  FileArchive,
  FileText,
  MapPin,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

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

function docTone(type?: string) {
  const text = String(type || "").toLowerCase();
  if (text.includes("drawing") || text.includes("plan")) return "border-cyan-300/20 bg-cyan-300/10 text-cyan-100";
  if (text.includes("decision")) return "border-emerald-300/20 bg-emerald-300/10 text-emerald-100";
  if (text.includes("form")) return "border-violet-300/20 bg-violet-300/10 text-violet-100";
  return "border-slate-300/20 bg-slate-300/10 text-slate-200";
}

function eventIcon(type?: string) {
  const value = String(type || "").toLowerCase();
  if (value.includes("document")) return FileText;
  if (value.includes("decision")) return CheckCircle2;
  if (value.includes("validated") || value.includes("received")) return Clock3;
  return Activity;
}

export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  const app = await getApplicationDetail(resolvedParams.id);

  if (!app) notFound();

  const sourceUrl = app.source_url || app.sourceUrl;
  const planitUrl = app.planit_url || app.planitUrl;
  const documentsUrl = sourceUrl?.includes("activeTab=")
    ? sourceUrl.replace(/activeTab=[^&]+/i, "activeTab=documents")
    : sourceUrl ? `${sourceUrl}${sourceUrl.includes("?") ? "&" : "?"}activeTab=documents` : undefined;
  const latestIntel = app.intelligence?.[0];
  const confidence = Math.round(((latestIntel?.confidence || latestIntel?.classification?.confidence || 0) as number) * 100);

  const stats = [
    { label: "Council", value: app.council || "Unknown", icon: Building2 },
    { label: "Decision", value: cleanStatus(app.decision), icon: ShieldCheck },
    { label: "Platform", value: app.platform || "Unknown", icon: Database },
    { label: "Documents", value: `${app.documents?.length || 0} files`, icon: FileArchive },
    { label: "Timeline Events", value: `${app.timeline?.length || 0}`, icon: CalendarClock },
    { label: "Last Updated", value: formatDate(app.timeline?.at(-1)?.date || app.updated_at), icon: Clock3 },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-7 px-5 py-6 sm:px-8 lg:px-10">
      <section className="glass-panel relative overflow-hidden rounded-xl p-6 sm:p-8">
        <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(34,211,238,.12),transparent_35%,rgba(139,92,246,.13))]" />
        <div className="relative flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge className={statusClass(app.decision)}>{cleanStatus(app.decision)}</Badge>
              <Badge variant="outline" className="border-cyan-300/20 bg-cyan-300/10 text-cyan-100">{app.council || "Unknown council"}</Badge>
              <Badge variant="outline" className="border-violet-300/20 bg-violet-300/10 text-violet-100">{app.platform || "Unknown platform"}</Badge>
            </div>
            <h1 className="max-w-5xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">{app.application_id}</h1>
            <p className="mt-5 max-w-5xl text-lg font-medium leading-8 text-slate-100">{app.proposal || "No proposal captured."}</p>
            <p className="mt-4 flex max-w-3xl items-center gap-2 text-sm text-slate-400">
              <MapPin className="h-4 w-4 text-cyan-300" />
              {app.address || "No address captured"}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <SourceActions sourceUrl={sourceUrl} planitUrl={planitUrl} documentsUrl={documentsUrl} />
            {app.documents?.[0]?.url && (
              <a href={app.documents[0].url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-400 to-violet-500 px-3 py-2 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-500/20">
                <Download className="h-4 w-4" />
                Download Package
              </a>
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        {stats.map(stat => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="premium-card p-4">
              <Icon className="mb-4 h-5 w-5 text-cyan-300" />
              <div className="truncate text-base font-semibold text-white">{stat.value}</div>
              <div className="mt-1 text-xs uppercase tracking-wide text-slate-500">{stat.label}</div>
            </div>
          );
        })}
      </section>

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList className="glass-panel h-auto flex-wrap rounded-xl p-1">
          <TabsTrigger value="overview" className="rounded-lg px-4 py-2">Overview</TabsTrigger>
          <TabsTrigger value="timeline" className="rounded-lg px-4 py-2">Timeline ({app.timeline?.length || 0})</TabsTrigger>
          <TabsTrigger value="documents" className="rounded-lg px-4 py-2">Documents ({app.documents?.length || 0})</TabsTrigger>
          <TabsTrigger value="intelligence" className="rounded-lg px-4 py-2">Intelligence ({app.intelligence?.length || 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="grid gap-5 lg:grid-cols-[.95fr_1.05fr]">
          <section className="premium-card p-5">
            <div className="mb-5 flex items-center gap-3">
              <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-2">
                <BrainCircuit className="h-5 w-5 text-cyan-200" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">AI Intelligence</h2>
                <p className="text-sm text-slate-500">Classification, confidence, and extracted findings.</p>
              </div>
            </div>
            {latestIntel ? (
              <div className="space-y-5">
                <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                  <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Classification</div>
                  <div className="text-xl font-semibold text-white">{latestIntel.classification?.category || "Planning Document"}</div>
                </div>
                <div>
                  <div className="mb-2 flex justify-between text-sm">
                    <span className="text-slate-400">Confidence Score</span>
                    <span className="font-semibold text-cyan-100">{confidence}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-violet-400" style={{ width: `${Math.max(confidence, 6)}%` }} />
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Key Findings</div>
                  <div className="flex flex-wrap gap-2">
                    {(latestIntel.extracted_keywords || latestIntel.classification?.signals || ["No signals captured"]).map((item, index) => (
                      <Badge key={`${item}-${index}`} className="border border-cyan-300/20 bg-cyan-300/10 text-cyan-100">{item}</Badge>
                    ))}
                  </div>
                </div>
                <p className="text-sm leading-6 text-slate-300">{latestIntel.summary || "Structured intelligence is available for this application."}</p>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.025] p-8 text-center">
                <Sparkles className="mx-auto mb-4 h-8 w-8 text-violet-300" />
                <h3 className="text-base font-semibold text-white">No intelligence yet</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">Once PDFs are parsed, classifications, confidence, key findings, and decision summaries will appear here.</p>
              </div>
            )}
          </section>

          <section className="premium-card p-5">
            <h2 className="text-lg font-semibold text-white">Application Summary</h2>
            <div className="mt-5 divide-y divide-white/10">
              {[
                ["Council", app.council || "Unknown"],
                ["Decision", cleanStatus(app.decision)],
                ["Decision Date", formatDate(app.decision_date)],
                ["Platform", app.platform || "Unknown"],
                ["Address", app.address || "No address captured"],
              ].map(([label, value]) => (
                <div key={label} className="grid gap-3 py-4 text-sm sm:grid-cols-[160px_1fr]">
                  <span className="text-slate-500">{label}</span>
                  <span className="font-medium text-slate-200">{value}</span>
                </div>
              ))}
              {sourceUrl && (
                <div className="grid gap-3 py-4 text-sm sm:grid-cols-[160px_1fr]">
                  <span className="text-slate-500">Source URL</span>
                  <a href={sourceUrl} target="_blank" rel="noreferrer" className="break-all font-medium text-cyan-100 transition hover:text-cyan-200">
                    {sourceUrl}
                  </a>
                </div>
              )}
              {planitUrl && (
                <div className="grid gap-3 py-4 text-sm sm:grid-cols-[160px_1fr]">
                  <span className="text-slate-500">PlanIt URL</span>
                  <a href={planitUrl} target="_blank" rel="noreferrer" className="break-all font-medium text-emerald-100 transition hover:text-emerald-200">
                    {planitUrl}
                  </a>
                </div>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="documents">
          {(!app.documents || app.documents.length === 0) ? (
            <section className="glass-panel flex min-h-[320px] flex-col items-center justify-center rounded-xl p-10 text-center">
              <FileArchive className="mb-4 h-10 w-10 text-cyan-300" />
              <h2 className="text-lg font-semibold text-white">No documents indexed</h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">Run the document download workflow for this application to populate stored PDFs and document metadata.</p>
            </section>
          ) : (
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {app.documents.map((doc, index) => (
                <article key={`${doc.name}-${index}`} className="premium-card p-4">
                  <div className="mb-4 flex items-start justify-between gap-4">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.045]">
                      <FileText className="h-5 w-5 text-cyan-200" />
                    </div>
                    {doc.url && (
                      <a href={doc.url} target="_blank" rel="noreferrer" className="rounded-lg border border-white/10 p-2 text-slate-300 transition hover:border-cyan-300/40 hover:bg-cyan-300/10 hover:text-cyan-100" title="Preview or download document">
                        <ArrowUpRight className="h-4 w-4" />
                      </a>
                    )}
                  </div>
                  <h3 className="line-clamp-2 min-h-12 text-base font-semibold leading-6 text-white">{doc.name}</h3>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Badge className={docTone(doc.type)}>{doc.type || "Document"}</Badge>
                    <Badge variant="outline" className="border-white/10 text-slate-400">{formatDate(doc.date)}</Badge>
                  </div>
                  <div className="mt-4 border-t border-white/10 pt-3 text-xs font-mono text-slate-600">{doc.hash ? doc.hash.substring(0, 16) : "hash pending"}</div>
                </article>
              ))}
            </section>
          )}
        </TabsContent>

        <TabsContent value="timeline">
          <section className="glass-panel rounded-xl p-5 sm:p-7">
            {(!app.timeline || app.timeline.length === 0) ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center text-center">
                <CalendarClock className="mb-4 h-10 w-10 text-violet-300" />
                <h2 className="text-lg font-semibold text-white">No timeline events</h2>
                <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">Council received, validated, document, and decision events will appear once captured.</p>
              </div>
            ) : (
              <div className="relative space-y-0">
                {app.timeline.map((event, index) => {
                  const Icon = eventIcon(event.type);
                  return (
                    <div key={`${event.type}-${event.date}-${index}`} className="relative grid gap-4 pb-8 last:pb-0 sm:grid-cols-[170px_1fr]">
                      {index !== app.timeline.length - 1 && <div className="absolute left-[24px] top-12 bottom-0 w-px bg-gradient-to-b from-cyan-300/40 to-white/10 sm:left-[194px]" />}
                      <time className="text-sm font-medium text-slate-400 sm:pt-3">{formatDate(event.date)}</time>
                      <div className="relative rounded-xl border border-white/10 bg-white/[0.035] p-4">
                        <div className="absolute -left-3 top-4 flex h-7 w-7 items-center justify-center rounded-full border border-cyan-300/30 bg-slate-950 text-cyan-200 shadow-lg shadow-cyan-500/20">
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <h3 className="pl-3 text-base font-semibold capitalize text-white">{event.type.replace(/_/g, " ")}</h3>
                        <p className="mt-1 pl-3 text-sm leading-6 text-slate-400">{event.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </TabsContent>

        <TabsContent value="intelligence">
          <section className="grid gap-4">
            {(!app.intelligence || app.intelligence.length === 0) ? (
              <div className="glass-panel flex min-h-[320px] flex-col items-center justify-center rounded-xl p-10 text-center">
                <BrainCircuit className="mb-4 h-10 w-10 text-violet-300" />
                <h2 className="text-lg font-semibold text-white">No AI analysis available</h2>
                <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">Document parsing will populate classification, confidence, important dates, and decision summaries.</p>
              </div>
            ) : (
              app.intelligence.map((intel, index) => (
                <article key={`${intel.model}-${index}`} className="premium-card p-5">
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-5">
                    <div>
                      <h2 className="text-lg font-semibold text-white">{intel.model || "AI Parser"}</h2>
                      <p className="mt-1 text-sm text-slate-500">{intel.classification?.category || "Document intelligence"}</p>
                    </div>
                    <Badge className="border border-emerald-300/20 bg-emerald-300/10 text-emerald-100">{Math.round(((intel.confidence || intel.classification?.confidence || 0) as number) * 100)}% Confidence</Badge>
                  </div>
                  <p className="text-sm leading-6 text-slate-300">{intel.summary || "No narrative summary available."}</p>
                  <div className="mt-5 flex flex-wrap gap-2">
                    {(intel.extracted_keywords || intel.classification?.signals || []).map((item, itemIndex) => (
                      <Badge key={`${item}-${itemIndex}`} className="border border-cyan-300/20 bg-cyan-300/10 text-cyan-100">{item}</Badge>
                    ))}
                  </div>
                </article>
              ))
            )}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
