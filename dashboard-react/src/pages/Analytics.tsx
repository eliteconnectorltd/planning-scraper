import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getApplicationsPage } from "@/lib/planning-api";

// Restrained categorical palette: blue shades + neutral + two semantic.
const COLORS = ["#2563eb", "#60a5fa", "#475569", "#15803d", "#b45309", "#94a3b8"];
const GRID = "#e5e7eb";
const AXIS = "#6b7280";

function chartTooltip() {
  return {
    backgroundColor: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: "6px",
    color: "#111827",
    fontSize: "12px",
    boxShadow: "none",
  };
}

function LoadingSkeleton() {
  return (
    <div className="page-container">
      <div className="h-16 animate-pulse rounded-lg bg-secondary" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map(item => <div key={item} className="h-24 animate-pulse rounded-lg bg-secondary" />)}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map(item => <div key={item} className="h-72 animate-pulse rounded-lg bg-secondary" />)}
      </div>
    </div>
  );
}

export default function Analytics() {
  const { data: records = [], isLoading: loading } = useQuery({
    queryKey: ["analytics-dataset"],
    queryFn: () => getApplicationsPage({ page: 1, pageSize: 100 }).then(result => result.data),
  });

  const analytics = useMemo(() => {
    const councilCounts = records.reduce((acc, record) => {
      acc[record.council || "Unknown"] = (acc[record.council || "Unknown"] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const decisionCounts = records.reduce((acc, record) => {
      const decision = record.decision || "PENDING";
      acc[decision] = (acc[decision] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const docCounts = records.flatMap(record => record.documents || []).reduce((acc, doc) => {
      const type = doc.type || "Document";
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const weeklyCounts = records.reduce((acc, record) => {
      const date = record.timeline?.at(-1)?.date || record.updated_at;
      const parsed = date ? new Date(date) : null;
      const label = parsed && !Number.isNaN(parsed.getTime())
        ? `${parsed.getDate().toString().padStart(2, "0")}/${(parsed.getMonth() + 1).toString().padStart(2, "0")}`
        : "Unknown";
      acc[label] = (acc[label] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      councils: Object.entries(councilCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8),
      decisions: Object.entries(decisionCounts).map(([name, value]) => ({ name, value })),
      documents: Object.entries(docCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8),
      weekly: Object.entries(weeklyCounts).map(([name, count]) => ({ name, count })).slice(-10),
      totalDocs: records.reduce((total, record) => total + (record.documents?.length || 0), 0),
      councilsCount: Object.keys(councilCounts).length,
    };
  }, [records]);

  if (loading) return <LoadingSkeleton />;

  return (
    <div className="page-container">
      <header>
        <h1 className="page-title">Analytics</h1>
        <p className="page-description">Council activity, decision outcomes, document mix, and update cadence.</p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Applications", value: records.length },
          { label: "Documents", value: analytics.totalDocs },
          { label: "Councils", value: analytics.councilsCount },
          { label: "Decision buckets", value: analytics.decisions.length },
        ].map(item => (
          <div key={item.label} className="card-surface p-4">
            <div className="text-2xl font-semibold tabular-nums text-foreground">{item.value}</div>
            <div className="page-description">{item.label}</div>
          </div>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="card-surface p-4">
          <h2 className="mb-4 text-sm font-semibold text-foreground">Applications by council</h2>
          <div className="h-64 sm:h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.councils} layout="vertical" margin={{ top: 4, right: 8, left: 16, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID} horizontal={false} />
                <XAxis type="number" stroke={AXIS} fontSize={12} />
                <YAxis dataKey="name" type="category" stroke={AXIS} fontSize={12} width={92} tickLine={false} />
                <Tooltip cursor={{ fill: "rgba(0,0,0,.04)" }} contentStyle={chartTooltip()} />
                <Bar dataKey="count" fill="#2563eb" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card-surface p-4">
          <h2 className="mb-4 text-sm font-semibold text-foreground">Decision outcomes</h2>
          <div className="grid min-h-72 items-center gap-4 md:grid-cols-[1fr_180px]">
            {analytics.decisions.length <= 1 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {analytics.decisions[0]?.value || 0} records
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={analytics.decisions} cx="50%" cy="50%" innerRadius={54} outerRadius={96} paddingAngle={2} dataKey="value" stroke="#ffffff" strokeWidth={2}>
                    {analytics.decisions.map((entry, index) => <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={chartTooltip()} />
                </PieChart>
              </ResponsiveContainer>
            )}
            <div className="space-y-1.5">
              {analytics.decisions.map((entry, index) => (
                <div key={entry.name} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                    <span className="truncate">{entry.name}</span>
                  </span>
                  <span className="font-semibold tabular-nums text-foreground">{entry.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card-surface p-4">
          <h2 className="mb-4 text-sm font-semibold text-foreground">Documents by type</h2>
          <div className="h-64 sm:h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.documents} margin={{ top: 4, right: 8, left: 0, bottom: 36 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
                <XAxis dataKey="name" stroke={AXIS} fontSize={11} angle={-18} textAnchor="end" height={70} interval={0} />
                <YAxis stroke={AXIS} fontSize={12} />
                <Tooltip cursor={{ fill: "rgba(0,0,0,.04)" }} contentStyle={chartTooltip()} />
                <Bar dataKey="count" fill="#475569" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card-surface p-4">
          <h2 className="mb-4 text-sm font-semibold text-foreground">Weekly activity</h2>
          <div className="h-64 sm:h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={analytics.weekly} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
                <XAxis dataKey="name" stroke={AXIS} fontSize={12} />
                <YAxis stroke={AXIS} fontSize={12} />
                <Tooltip contentStyle={chartTooltip()} />
                <Line type="monotone" dataKey="count" stroke="#2563eb" strokeWidth={2} dot={{ r: 2, fill: "#2563eb" }} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>
    </div>
  );
}
