import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SourceActions } from "@/components/source-actions";
import { getApplicationDetail } from "@/lib/planning-api";
import { Loading } from "@/components/loading";
import NotFound from "@/pages/NotFound";
import { Download, MapPin } from "lucide-react";

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
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
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

  const stats = [
    { label: "Council", value: app.council || "Unknown" },
    { label: "Decision", value: cleanStatus(app.decision) },
    { label: "Platform", value: app.platform || "Unknown" },
    { label: "Documents", value: `${app.documents?.length || 0}` },
    { label: "Timeline events", value: `${app.timeline?.length || 0}` },
    { label: "Last updated", value: formatDate(app.timeline?.at(-1)?.date || app.updated_at) },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-6 py-6">
      <section className="card-surface p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className={`${chip} ${statusClass(app.decision)}`}>{cleanStatus(app.decision)}</span>
              <span className={`${chip} border-border bg-secondary text-muted-foreground`}>{app.council || "Unknown council"}</span>
              <span className={`${chip} border-border bg-secondary text-muted-foreground`}>{app.platform || "Unknown platform"}</span>
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{app.application_id}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-foreground">{app.proposal || "No proposal captured."}</p>
            <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
              <MapPin className="h-4 w-4" />
              {app.address || "No address captured"}
            </p>
          </div>

          <div className="flex flex-col items-start gap-2">
            <SourceActions sourceUrl={sourceUrl} planitUrl={planitUrl} documentsUrl={documentsUrl} />
            {app.documents?.[0]?.url && (
              <a href={app.documents[0].url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-[#1d4ed8]">
                <Download className="h-4 w-4" />
                Download
              </a>
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {stats.map(stat => (
          <div key={stat.label} className="card-surface p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{stat.label}</div>
            <div className="mt-1 truncate text-sm font-semibold text-foreground">{stat.value}</div>
          </div>
        ))}
      </section>

      <Tabs defaultValue="overview" className="gap-4">
        <TabsList variant="line" className="w-full justify-start border-b border-border">
          <TabsTrigger value="overview" className="px-3 py-2">Overview</TabsTrigger>
          <TabsTrigger value="timeline" className="px-3 py-2">Timeline ({app.timeline?.length || 0})</TabsTrigger>
          <TabsTrigger value="documents" className="px-3 py-2">Documents ({app.documents?.length || 0})</TabsTrigger>
          <TabsTrigger value="intelligence" className="px-3 py-2">Intelligence ({app.intelligence?.length || 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="grid gap-4 lg:grid-cols-2">
          <section className="card-surface p-5">
            <h2 className="text-sm font-semibold text-foreground">AI intelligence</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Classification, confidence, and extracted findings.</p>
            {latestIntel ? (
              <div className="mt-4 space-y-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Classification</div>
                  <div className="mt-1 text-base font-semibold text-foreground">{latestIntel.classification?.category || "Planning Document"}</div>
                </div>
                <div>
                  <div className="mb-1.5 flex justify-between text-sm">
                    <span className="text-muted-foreground">Confidence</span>
                    <span className="font-semibold tabular-nums text-foreground">{confidence}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(confidence, 4)}%` }} />
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">Key findings</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(latestIntel.extracted_keywords || latestIntel.classification?.signals || ["No signals captured"]).map((item, index) => (
                      <span key={`${item}-${index}`} className={`${chip} border-border bg-secondary text-muted-foreground`}>{item}</span>
                    ))}
                  </div>
                </div>
                <p className="text-sm leading-6 text-foreground">{latestIntel.summary || "Structured intelligence is available for this application."}</p>
              </div>
            ) : (
              <div className="mt-4 rounded-md border border-dashed border-border p-6 text-center">
                <h3 className="text-sm font-semibold text-foreground">No intelligence yet</h3>
                <p className="mt-1 text-sm text-muted-foreground">Once PDFs are parsed, classifications, confidence, and findings will appear here.</p>
              </div>
            )}
          </section>

          <section className="card-surface p-5">
            <h2 className="text-sm font-semibold text-foreground">Application summary</h2>
            <div className="mt-3 divide-y divide-border">
              {[
                ["Council", app.council || "Unknown"],
                ["Decision", cleanStatus(app.decision)],
                ["Decision date", formatDate(app.decision_date)],
                ["Platform", app.platform || "Unknown"],
                ["Address", app.address || "No address captured"],
              ].map(([label, value]) => (
                <div key={label} className="grid gap-2 py-2.5 text-sm sm:grid-cols-[140px_1fr]">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-medium text-foreground">{value}</span>
                </div>
              ))}
              {sourceUrl && (
                <div className="grid gap-2 py-2.5 text-sm sm:grid-cols-[140px_1fr]">
                  <span className="text-muted-foreground">Source URL</span>
                  <a href={sourceUrl} target="_blank" rel="noreferrer" className="break-all font-medium text-primary hover:underline">{sourceUrl}</a>
                </div>
              )}
              {planitUrl && (
                <div className="grid gap-2 py-2.5 text-sm sm:grid-cols-[140px_1fr]">
                  <span className="text-muted-foreground">PlanIt URL</span>
                  <a href={planitUrl} target="_blank" rel="noreferrer" className="break-all font-medium text-primary hover:underline">{planitUrl}</a>
                </div>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="documents">
          {(!app.documents || app.documents.length === 0) ? (
            <div className="card-surface flex min-h-[240px] flex-col items-center justify-center p-10 text-center">
              <h2 className="text-base font-semibold text-foreground">No documents indexed</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">Run the document download workflow for this application to populate stored PDFs and metadata.</p>
            </div>
          ) : (
            <div className="card-surface overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Document</th>
                      <th className="px-4 py-2.5 font-medium">Type</th>
                      <th className="px-4 py-2.5 font-medium">Date</th>
                      <th className="px-4 py-2.5 font-medium">Hash</th>
                      <th className="px-4 py-2.5 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {app.documents.map((doc, index) => (
                      <tr key={`${doc.name}-${index}`} className="border-b border-border last:border-0">
                        <td className="max-w-[360px] px-4 py-3 align-top">
                          <span className="line-clamp-2 font-medium text-foreground">{doc.name}</span>
                        </td>
                        <td className="px-4 py-3 align-top text-muted-foreground">{doc.type || "Document"}</td>
                        <td className="px-4 py-3 align-top whitespace-nowrap text-muted-foreground">{formatDate(doc.date)}</td>
                        <td className="px-4 py-3 align-top font-mono text-xs text-muted-foreground">{doc.hash ? doc.hash.substring(0, 12) : "—"}</td>
                        <td className="px-4 py-3 align-top text-right">
                          {doc.url && (
                            <a href={doc.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">Open</a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="timeline">
          <section className="card-surface p-5">
            {(!app.timeline || app.timeline.length === 0) ? (
              <div className="flex min-h-[200px] flex-col items-center justify-center text-center">
                <h2 className="text-base font-semibold text-foreground">No timeline events</h2>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">Received, validated, document, and decision events will appear once captured.</p>
              </div>
            ) : (
              <ol className="divide-y divide-border">
                {app.timeline.map((event, index) => (
                  <li key={`${event.type}-${event.date}-${index}`} className="grid gap-1 py-3 sm:grid-cols-[140px_1fr]">
                    <time className="text-sm text-muted-foreground">{formatDate(event.date)}</time>
                    <div>
                      <div className="text-sm font-medium capitalize text-foreground">{event.type.replace(/_/g, " ")}</div>
                      <p className="mt-0.5 text-sm text-muted-foreground">{event.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </TabsContent>

        <TabsContent value="intelligence">
          <div className="grid gap-4">
            {(!app.intelligence || app.intelligence.length === 0) ? (
              <div className="card-surface flex min-h-[240px] flex-col items-center justify-center p-10 text-center">
                <h2 className="text-base font-semibold text-foreground">No AI analysis available</h2>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">Document parsing will populate classification, confidence, important dates, and summaries.</p>
              </div>
            ) : (
              app.intelligence.map((intel, index) => (
                <article key={`${intel.model}-${index}`} className="card-surface p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">{intel.model || "AI Parser"}</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">{intel.classification?.category || "Document intelligence"}</p>
                    </div>
                    <span className={`${chip} border-border bg-secondary text-muted-foreground`}>{Math.round(((intel.confidence || intel.classification?.confidence || 0) as number) * 100)}% confidence</span>
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
