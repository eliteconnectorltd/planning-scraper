import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { getApplicationsPage, getChangeFeed } from "@/lib/planning-api";
import { Loading } from "@/components/loading";

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-GB").format(value || 0);
}

export default function Overview() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["overview"],
    queryFn: async () => {
      const [apps, changes] = await Promise.all([
        getApplicationsPage({ page: 1, pageSize: 100 }),
        getChangeFeed({ page: 1, pageSize: 100 }),
      ]);
      return { records: apps.data, count: apps.count, changeLog: changes.data };
    },
  });

  if (isError) {
    return (
      <div className="page-container">
        <div className="card-surface p-5 text-sm text-muted-foreground">
          <div className="mb-1 font-semibold text-foreground">Couldn&apos;t load overview data</div>
          <p>{error instanceof Error ? error.message : "Unknown error"}</p>
        </div>
      </div>
    );
  }

  if (isLoading || !data) return <Loading />;

  const { records, count, changeLog } = data;

  const totalApplications = count || records.length;
  const totalDocuments = records.reduce((acc, record) => acc + (record.documents?.length || 0), 0);
  const councils = new Set(records.map(record => record.council).filter(Boolean)).size;
  const decisionsRecorded = records.filter(record => record.decision_date).length;
  const timelineEvents = records.reduce((acc, record) => acc + (record.timeline?.length || 0), 0);
  const latestChanges = changeLog[0]; // getChangeFeed returns newest-first
  const newDocs = latestChanges?.summary.new_documents || 0;
  const newApps = latestChanges?.summary.new_applications || 0;

  const kpis = [
    { label: "Applications", value: totalApplications },
    { label: "Documents", value: totalDocuments },
    { label: "Decisions recorded", value: decisionsRecorded },
    { label: "Councils", value: councils },
  ];

  const councilCoverage = Array.from(new Set(records.map(record => record.council).filter(Boolean)))
    .map(council => ({ council, count: records.filter(record => record.council === council).length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return (
    <div className="page-container gap-6">
      <header className="page-header">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-description">
            Planning applications, documents, and change signals across tracked councils.
          </p>
        </div>
        <Link to="/applications" className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:border-border-strong hover:bg-secondary sm:h-9">
          View applications
          <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
        </Link>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map(kpi => (
          <div key={kpi.label} className="card-surface p-4">
            <div className="text-2xl font-semibold tabular-nums text-foreground">{formatNumber(kpi.value)}</div>
            <div className="page-description">{kpi.label}</div>
          </div>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="card-surface lg:col-span-2">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">Recent activity</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Latest detected movements and indexed signals.</p>
          </div>
          <div className="divide-y divide-border">
            {[
              ["New applications", newApps || records.length, "Captured from tracked portals"],
              ["Documents indexed", newDocs || totalDocuments, "Stored in Supabase and linked to records"],
              ["Timeline events", timelineEvents, "Council dates and document additions"],
            ].map(([title, value, description]) => (
              <div key={title as string} className="flex items-start justify-between gap-4 px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-foreground">{title}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
                </div>
                <div className="text-sm font-semibold tabular-nums text-foreground">{formatNumber(Number(value))}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card-surface">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">Council coverage</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Applications by authority.</p>
          </div>
          <div className="divide-y divide-border">
            {councilCoverage.map(({ council, count: countForCouncil }) => (
              <div key={council} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="truncate text-sm text-foreground">{council}</span>
                <span className="text-sm font-semibold tabular-nums text-muted-foreground">{countForCouncil}</span>
              </div>
            ))}
            {councilCoverage.length === 0 && (
              <div className="px-4 py-6 text-sm text-muted-foreground">No councils captured yet.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
