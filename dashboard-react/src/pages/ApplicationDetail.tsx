import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SourceActions } from "@/components/source-actions";
import { getApplicationDetail } from "@/lib/planning-api";
import { Loading } from "@/components/loading";
import NotFound from "@/pages/NotFound";
import { ArrowLeft, Building2, CalendarDays, Clock3, Download, FileText, MapPin, Server } from "lucide-react";

function statusClass(decision?: string | null) {
  const value = String(decision || "PENDING").toUpperCase();
  if (value.includes("GRANT") || value.includes("APPROV")) return "border-green-200 bg-green-50 text-green-700";
  if (value.includes("REFUS")) return "border-red-200 bg-red-50 text-red-700";
  if (value.includes("WITHDRAW")) return "border-slate-200 bg-slate-100 text-slate-600";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function cleanStatus(decision?: string | null) {
  if (!decision || decision === "PENDING") return "Pending";
  return decision.toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

const chip = "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium";

export default function ApplicationDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: app, isLoading } = useQuery({
    queryKey: ["application", id],
    queryFn: () => getApplicationDetail(id!),
    enabled: !!id,
  });

  if (isLoading) return <Loading />;
  if (!app) return <NotFound />;

  const sourceUrl = app.source_url || app.sourceUrl;
  const planitUrl = app.planit_url || app.planitUrl;
  const documentsUrl = sourceUrl?.includes("activeTab=")
    ? sourceUrl.replace(/activeTab=[^&]+/i, "activeTab=documents")
    : sourceUrl ? `${sourceUrl}${sourceUrl.includes("?") ? "&" : "?"}activeTab=documents` : undefined;
  const latestIntel = app.intelligence?.[0];
  const confidence = Math.round(((latestIntel?.confidence || latestIntel?.classification?.confidence || 0) as number) * 100);
  const lastUpdated = app.timeline?.at(-1)?.date || app.updated_at;

  const stats = [
    { label: "Council", value: app.council || "Unknown", icon: Building2 },
    { label: "Decision", value: cleanStatus(app.decision), icon: CalendarDays },
    { label: "Platform", value: app.platform || "Unknown", icon: Server },
    { label: "Documents", value: `${app.documents?.length || 0}`, icon: FileText },
    { label: "Timeline", value: `${app.timeline?.length || 0} events`, icon: Clock3 },
    { label: "Updated", value: formatDate(lastUpdated), icon: CalendarDays },
  ];

  return (
    <div className="page-container">
      <div className="flex items-center justify-between gap-3">
        <Link to="/applications" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-secondary">
          <ArrowLeft className="h-4 w-4 text-muted-foreground" />
          Applications
        </Link>
        <span className="hidden text-xs text-muted-foreground sm:inline">Reference {app.application_id}</span>
      </div>

      <section className="card-surface overflow-hidden border-l-4 border-l-primary">
        <div className="grid gap-5 p-4 sm:p-5 xl:grid-cols-[1fr_320px]">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className={`${chip} ${statusClass(app.decision)}`}>{cleanStatus(app.decision)}</span>
              <span className={`${chip} border-border bg-secondary text-muted-foreground`}>{app.council || "Unknown council"}</span>
              <span className={`${chip} border-border bg-secondary text-muted-foreground`}>{app.platform || "Unknown platform"}</span>
            </div>
            <h1 className="break-words text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{app.application_id}</h1>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-foreground sm:text-[15px]">{app.proposal || "No proposal captured."}</p>
            <p className="mt-3 flex items-start gap-1.5 text-sm text-muted-foreground">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{app.address || "No address captured"}</span>
            </p>
          </div>

          <aside className="rounded-md border border-border bg-secondary/35 p-3">
            <div className="section-kicker">Record snapshot</div>
            <div className="mt-3 grid gap-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Decision date</span>
                <span className="font-medium text-foreground">{formatDate(app.decision_date)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Documents</span>
                <span className="font-medium tabular-nums text-foreground">{app.documents?.length || 0}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Last updated</span>
                <span className="font-medium text-foreground">{formatDate(lastUpdated)}</span>
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2">
              <SourceActions sourceUrl={sourceUrl} planitUrl={planitUrl} documentsUrl={documentsUrl} />
              {app.documents?.[0]?.url && (
                <a href={app.documents[0].url} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-[0_1px_2px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1d4ed8]">
                  <Download className="h-4 w-4" />
                  Download latest
                </a>
              )}
            </div>
          </aside>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {stats.map(stat => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="card-surface bg-card/95 p-3">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0">
                  <div className="section-kicker">{stat.label}</div>
                  <div className="mt-0.5 min-w-0 break-words text-sm font-semibold text-foreground">{stat.value}</div>
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <Tabs defaultValue="overview" className="gap-4">
        <div className="sticky top-0 z-10 overflow-x-auto border-b border-border bg-background/95 pt-1 backdrop-blur lg:top-0">
          <TabsList variant="line" className="min-w-max justify-start border-b-0">
            <TabsTrigger value="overview" className="px-3 py-2">Overview</TabsTrigger>
            <TabsTrigger value="timeline" className="px-3 py-2">Timeline ({app.timeline?.length || 0})</TabsTrigger>
            <TabsTrigger value="documents" className="px-3 py-2">Documents ({app.documents?.length || 0})</TabsTrigger>
            <TabsTrigger value="intelligence" className="px-3 py-2">Intelligence ({app.intelligence?.length || 0})</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
          <section className="card-surface p-4 sm:p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">AI intelligence</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Classification, confidence, and extracted findings.</p>
              </div>
              {latestIntel && <span className={`${chip} border-border bg-secondary text-muted-foreground`}>{confidence}% confidence</span>}
            </div>
            {latestIntel ? (
              <div className="mt-4 space-y-4">
                <div>
                  <div className="section-kicker">Classification</div>
                  <div className="mt-1 text-base font-semibold text-foreground">{latestIntel.classification?.category || "Planning Document"}</div>
                </div>
                <div>
                  <div className="mb-1.5 flex justify-between text-sm">
                    <span className="text-muted-foreground">Confidence</span>
                    <span className="font-semibold tabular-nums text-foreground">{confidence}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(confidence, 4)}%` }} />
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 section-kicker">Key findings</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(latestIntel.extracted_keywords || latestIntel.classification?.signals || ["No signals captured"]).map((item, index) => (
                      <span key={`${item}-${index}`} className={`${chip} border-border bg-secondary text-muted-foreground`}>{item}</span>
                    ))}
                  </div>
                </div>
                <p className="rounded-md border border-border bg-secondary/30 p-3 text-sm leading-6 text-foreground">{latestIntel.summary || "Structured intelligence is available for this application."}</p>
              </div>
            ) : (
              <div className="mt-4 rounded-md border border-dashed border-border bg-secondary/40 p-6 text-center">
                <h3 className="text-sm font-semibold text-foreground">No intelligence yet</h3>
                <p className="mt-1 text-sm text-muted-foreground">Once PDFs are parsed, classifications, confidence, and findings will appear here.</p>
              </div>
            )}
          </section>

          <section className="card-surface p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-foreground">Application summary</h2>
            <div className="mt-3 divide-y divide-border">
              {[
                ["Council", app.council || "Unknown"],
                ["Decision", cleanStatus(app.decision)],
                ["Decision date", formatDate(app.decision_date)],
                ["Platform", app.platform || "Unknown"],
                ["Address", app.address || "No address captured"],
              ].map(([label, value]) => (
                <div key={label} className="grid gap-1 py-2.5 text-sm sm:grid-cols-[140px_1fr] sm:gap-2">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="break-words font-medium text-foreground">{value}</span>
                </div>
              ))}
              {sourceUrl && (
                <div className="grid gap-1 py-2.5 text-sm sm:grid-cols-[140px_1fr] sm:gap-2">
                  <span className="text-muted-foreground">Source URL</span>
                  <a href={sourceUrl} target="_blank" rel="noreferrer" className="break-all font-medium text-primary hover:underline">{sourceUrl}</a>
                </div>
              )}
              {planitUrl && (
                <div className="grid gap-1 py-2.5 text-sm sm:grid-cols-[140px_1fr] sm:gap-2">
                  <span className="text-muted-foreground">PlanIt URL</span>
                  <a href={planitUrl} target="_blank" rel="noreferrer" className="break-all font-medium text-primary hover:underline">{planitUrl}</a>
                </div>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="documents">
          {(!app.documents || app.documents.length === 0) ? (
            <div className="card-surface flex min-h-[240px] flex-col items-center justify-center p-8 text-center sm:p-10">
              <h2 className="text-base font-semibold text-foreground">No documents indexed</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">Run the document download workflow for this application to populate stored PDFs and metadata.</p>
            </div>
          ) : (
            <>
              <div className="hidden card-surface overflow-hidden md:block">
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-border bg-secondary/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-2.5 font-medium">Document</th>
                        <th className="px-4 py-2.5 font-medium">Type</th>
                        <th className="px-4 py-2.5 font-medium">Date</th>
                        <th className="px-4 py-2.5 font-medium">Hash</th>
                        <th className="px-4 py-2.5 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {app.documents.map((doc, index) => (
                        <tr key={`${doc.name}-${index}`} className="border-b border-border last:border-0 transition-colors hover:bg-secondary/50">
                          <td className="max-w-[420px] px-4 py-3 align-top">
                            <span className="line-clamp-2 font-medium text-foreground">{doc.name}</span>
                          </td>
                          <td className="px-4 py-3 align-top text-muted-foreground">{doc.type || "Document"}</td>
                          <td className="px-4 py-3 align-top whitespace-nowrap text-muted-foreground">{formatDate(doc.date)}</td>
                          <td className="px-4 py-3 align-top font-mono text-xs text-muted-foreground">{doc.hash ? doc.hash.substring(0, 12) : "-"}</td>
                          <td className="px-4 py-3 align-top text-right">
                            {doc.url && <a href={doc.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">Open</a>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="grid gap-3 md:hidden">
                {app.documents.map((doc, index) => (
                  <article key={`${doc.name}-${index}`} className="table-card-row">
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground">
                        <FileText className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="line-clamp-2 text-sm font-semibold text-foreground">{doc.name}</h3>
                        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span>{doc.type || "Document"}</span>
                          <span>{formatDate(doc.date)}</span>
                          {doc.hash && <span className="font-mono">{doc.hash.substring(0, 12)}</span>}
                        </div>
                        {doc.url && <a href={doc.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex h-8 items-center rounded-md border border-border bg-card px-2.5 text-sm font-medium text-primary hover:bg-secondary">Open document</a>}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="timeline">
          <section className="card-surface p-4 sm:p-5">
            {(!app.timeline || app.timeline.length === 0) ? (
              <div className="flex min-h-[200px] flex-col items-center justify-center text-center">
                <h2 className="text-base font-semibold text-foreground">No timeline events</h2>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">Received, validated, document, and decision events will appear once captured.</p>
              </div>
            ) : (
              <ol className="relative ml-2 border-l border-border pl-5">
                {app.timeline.map((event, index) => (
                  <li key={`${event.type}-${event.date}-${index}`} className="relative pb-5 last:pb-0">
                    <span className="absolute -left-[25px] top-1 flex h-3 w-3 rounded-full border-2 border-card bg-primary" />
                    <time className="text-xs font-medium text-muted-foreground">{formatDate(event.date)}</time>
                    <div className="mt-1 text-sm font-medium capitalize text-foreground">{event.type.replace(/_/g, " ")}</div>
                    <p className="mt-0.5 text-sm leading-6 text-muted-foreground">{event.description}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </TabsContent>

        <TabsContent value="intelligence">
          <div className="grid gap-4">
            {(!app.intelligence || app.intelligence.length === 0) ? (
              <div className="card-surface flex min-h-[240px] flex-col items-center justify-center p-8 text-center sm:p-10">
                <h2 className="text-base font-semibold text-foreground">No AI analysis available</h2>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">Document parsing will populate classification, confidence, important dates, and summaries.</p>
              </div>
            ) : (
              app.intelligence.map((intel, index) => (
                <article key={`${intel.model}-${index}`} className="card-surface p-4 sm:p-5">
                  <div className="flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">{intel.model || "AI Parser"}</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">{intel.classification?.category || "Document intelligence"}</p>
                    </div>
                    <span className={`${chip} w-fit border-border bg-secondary text-muted-foreground`}>{Math.round(((intel.confidence || intel.classification?.confidence || 0) as number) * 100)}% confidence</span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-foreground">{intel.summary || "No narrative summary available."}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(intel.extracted_keywords || intel.classification?.signals || []).map((item, itemIndex) => (
                      <span key={`${item}-${itemIndex}`} className={`${chip} border-border bg-secondary text-muted-foreground`}>{item}</span>
                    ))}
                  </div>
                </article>
              ))
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
