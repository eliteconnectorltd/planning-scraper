"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
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
import { Activity, BarChart3, Building2, FileText, PieChart as PieIcon, RadioTower } from "lucide-react";
import { ApplicationRecord } from "@/lib/api";

const COLORS = ["#22d3ee", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#60a5fa"];

function chartTooltip() {
  return {
    backgroundColor: "rgba(2, 6, 23, .92)",
    borderColor: "rgba(255,255,255,.12)",
    borderRadius: "10px",
    color: "#fff",
    boxShadow: "0 24px 60px rgba(0,0,0,.35)",
  };
}

function LoadingSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-5 py-6 sm:px-8 lg:px-10">
      <div className="h-24 animate-pulse rounded-xl bg-white/[0.055]" />
      <div className="grid gap-4 md:grid-cols-4">
        {[0, 1, 2, 3].map(item => <div key={item} className="h-32 animate-pulse rounded-lg bg-white/[0.055]" />)}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map(item => <div key={item} className="h-80 animate-pulse rounded-xl bg-white/[0.055]" />)}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const [records, setRecords] = useState<ApplicationRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dataset")
      .then(res => res.json())
      .then(data => setRecords(data))
      .catch(err => console.error("Could not load data:", err))
      .finally(() => setLoading(false));
  }, []);

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
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-7 px-5 py-6 sm:px-8 lg:px-10">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-medium text-cyan-200">
            <RadioTower className="h-3.5 w-3.5" />
            Executive analytics
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">Analytics</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
            Council activity, decision outcomes, document mix, and operating cadence across the planning graph.
          </p>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-4">
        {[
          { label: "Applications", value: records.length, icon: Activity },
          { label: "Documents", value: analytics.totalDocs, icon: FileText },
          { label: "Councils", value: analytics.councilsCount, icon: Building2 },
          { label: "Decision Buckets", value: analytics.decisions.length, icon: PieIcon },
        ].map((item, index) => {
          const Icon = item.icon;
          return (
            <motion.div
              key={item.label}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.04 }}
              className="premium-card p-5"
            >
              <Icon className="mb-5 h-5 w-5 text-cyan-300" />
              <div className="text-3xl font-semibold text-white">{item.value}</div>
              <div className="mt-1 text-sm text-slate-500">{item.label}</div>
            </motion.div>
          );
        })}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="premium-card p-5">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Applications by Council</h2>
              <p className="text-sm text-slate-500">Highest-volume planning authorities.</p>
            </div>
            <BarChart3 className="h-5 w-5 text-cyan-300" />
          </div>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.councils} layout="vertical" margin={{ top: 8, right: 20, left: 50, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" horizontal={false} />
                <XAxis type="number" stroke="rgba(255,255,255,.35)" fontSize={12} />
                <YAxis dataKey="name" type="category" stroke="rgba(255,255,255,.65)" fontSize={12} width={110} />
                <Tooltip cursor={{ fill: "rgba(255,255,255,.05)" }} contentStyle={chartTooltip()} />
                <Bar dataKey="count" fill="#22d3ee" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="premium-card p-5">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Decision Outcomes</h2>
              <p className="text-sm text-slate-500">Granted, pending, refused, and other outcomes.</p>
            </div>
            <PieIcon className="h-5 w-5 text-violet-300" />
          </div>
          <div className="grid h-80 items-center gap-4 md:grid-cols-[1fr_180px]">
            {analytics.decisions.length <= 1 ? (
              <div className="flex h-full items-center justify-center">
                <div className="relative flex h-52 w-52 items-center justify-center rounded-full bg-[conic-gradient(#22d3ee_0deg,rgba(34,211,238,.95)_360deg)] shadow-2xl shadow-cyan-500/10">
                  <div className="flex h-32 w-32 flex-col items-center justify-center rounded-full bg-slate-950">
                    <span className="text-3xl font-semibold text-white">{analytics.decisions[0]?.value || 0}</span>
                    <span className="text-xs uppercase tracking-wide text-slate-500">records</span>
                  </div>
                </div>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={analytics.decisions} cx="50%" cy="50%" innerRadius={58} outerRadius={104} paddingAngle={4} dataKey="value" stroke="rgba(255,255,255,.12)" strokeWidth={2}>
                    {analytics.decisions.map((entry, index) => <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={chartTooltip()} />
                </PieChart>
              </ResponsiveContainer>
            )}
            <div className="space-y-2">
              {analytics.decisions.map((entry, index) => (
                <div key={entry.name} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2 text-slate-300">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                    <span className="truncate">{entry.name}</span>
                  </span>
                  <span className="font-semibold text-white">{entry.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="premium-card p-5">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-white">Documents by Type</h2>
            <p className="text-sm text-slate-500">The dominant document categories being indexed.</p>
          </div>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.documents} margin={{ top: 8, right: 20, left: 0, bottom: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" vertical={false} />
                <XAxis dataKey="name" stroke="rgba(255,255,255,.55)" fontSize={12} angle={-10} textAnchor="end" height={58} />
                <YAxis stroke="rgba(255,255,255,.35)" fontSize={12} />
                <Tooltip cursor={{ fill: "rgba(255,255,255,.05)" }} contentStyle={chartTooltip()} />
                <Bar dataKey="count" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="premium-card p-5">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-white">Weekly Activity</h2>
            <p className="text-sm text-slate-500">Latest captured update cadence.</p>
          </div>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={analytics.weekly} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" vertical={false} />
                <XAxis dataKey="name" stroke="rgba(255,255,255,.55)" fontSize={12} />
                <YAxis stroke="rgba(255,255,255,.35)" fontSize={12} />
                <Tooltip contentStyle={chartTooltip()} />
                <Line type="monotone" dataKey="count" stroke="#22d3ee" strokeWidth={3} dot={{ r: 3, fill: "#22d3ee" }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>
    </div>
  );
}
