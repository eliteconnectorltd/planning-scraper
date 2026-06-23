"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  Activity,
  BarChart3,
  Building2,
  ChevronLeft,
  ChevronRight,
  Database,
  FileText,
  LayoutDashboard,
  Menu,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";

type ShellStats = {
  applications: number;
  documents: number;
  councils: number;
};

const navItems = [
  { href: "/", label: "Overview", icon: Activity },
  { href: "/applications", label: "Applications", icon: FileText },
  { href: "/changes", label: "Changes Feed", icon: Sparkles },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
];

function formatCompact(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function SidebarContent({
  collapsed,
  onToggle,
  stats,
  mobileClose,
}: {
  collapsed: boolean;
  onToggle: () => void;
  stats: ShellStats;
  mobileClose?: () => void;
}) {
  const pathname = usePathname();

  return (
    <aside className={`relative flex h-full flex-col border-r border-white/10 bg-slate-950/78 shadow-2xl shadow-black/40 backdrop-blur-2xl transition-all duration-300 ${collapsed ? "w-[88px]" : "w-[286px]"}`}>
      <div className="flex h-20 items-center gap-3 border-b border-white/10 px-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400 via-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/30">
          <LayoutDashboard className="h-5 w-5 text-white" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-tight text-white">PlanIt Intelligence</div>
            <div className="truncate text-xs text-slate-400">Planning OS</div>
          </div>
        )}
        {mobileClose && (
          <button onClick={mobileClose} className="ml-auto rounded-md border border-white/10 p-2 text-slate-300 hover:bg-white/10 lg:hidden" aria-label="Close navigation">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="px-4 py-4">
        <div className={`rounded-lg border border-white/10 bg-white/[0.04] p-3 shadow-inner shadow-white/5 ${collapsed ? "px-2" : ""}`}>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-cyan-400/10 text-cyan-200">
              <Building2 className="h-4 w-4" />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-slate-300">Workspace</div>
                <div className="truncate text-sm font-semibold text-white">UK Planning Graph</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {navItems.map(item => {
          const Icon = item.icon;
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className="group relative block" title={collapsed ? item.label : undefined}>
              {active && (
                <motion.span
                  layoutId="active-nav"
                  className="absolute inset-0 rounded-lg border border-indigo-400/25 bg-indigo-400/10 shadow-lg shadow-indigo-500/10"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              )}
              <span className={`relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${active ? "text-white" : "text-slate-400 hover:bg-white/[0.05] hover:text-slate-100"}`}>
                <Icon className={`h-4 w-4 shrink-0 ${active ? "text-cyan-300" : "text-slate-500 group-hover:text-cyan-300"}`} />
                {!collapsed && item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="space-y-3 border-t border-white/10 p-4">
        <div className={`grid gap-2 ${collapsed ? "grid-cols-1" : "grid-cols-3"}`}>
          {[
            { label: "Apps", value: stats.applications, icon: Activity },
            { label: "Docs", value: stats.documents, icon: FileText },
            { label: "Councils", value: stats.councils, icon: Database },
          ].map(stat => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="rounded-md border border-white/10 bg-white/[0.035] p-2">
                <Icon className="mb-1 h-3.5 w-3.5 text-cyan-300" />
                <div className="text-sm font-semibold text-white">{formatCompact(stat.value)}</div>
                {!collapsed && <div className="text-[10px] uppercase tracking-wide text-slate-500">{stat.label}</div>}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-emerald-400 to-cyan-500 text-xs font-bold text-slate-950">
            PI
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-white">Operations</div>
              <div className="truncate text-xs text-slate-500">Enterprise workspace</div>
            </div>
          )}
          {!collapsed && <Settings className="h-4 w-4 text-slate-500" />}
        </div>
      </div>

      <button
        onClick={onToggle}
        className="absolute -right-3 top-24 hidden h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-slate-900 text-slate-300 shadow-xl shadow-black/30 transition hover:border-cyan-400/40 hover:text-cyan-200 lg:flex"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
    </aside>
  );
}

export function AppShell({ children, stats }: { children: React.ReactNode; stats: ShellStats }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <body className="min-h-screen overflow-hidden bg-[#050712] text-slate-100 antialiased selection:bg-cyan-400/25">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(56,189,248,0.16),transparent_28%),radial-gradient(circle_at_80%_10%,rgba(139,92,246,0.14),transparent_30%),linear-gradient(180deg,#050712,#070816_42%,#04050c)]" />
      <div className="pointer-events-none fixed inset-0 opacity-[0.05] [background-image:linear-gradient(rgba(255,255,255,.7)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.7)_1px,transparent_1px)] [background-size:48px_48px]" />

      <div className="relative flex h-screen overflow-hidden">
        <div className="hidden lg:block">
          <SidebarContent collapsed={collapsed} onToggle={() => setCollapsed(value => !value)} stats={stats} />
        </div>

        {mobileOpen && (
          <div className="fixed inset-0 z-50 flex lg:hidden">
            <button className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileOpen(false)} aria-label="Close navigation overlay" />
            <motion.div initial={{ x: -320 }} animate={{ x: 0 }} exit={{ x: -320 }} transition={{ type: "spring", stiffness: 300, damping: 32 }} className="relative z-10">
              <SidebarContent collapsed={false} onToggle={() => setCollapsed(value => !value)} stats={stats} mobileClose={() => setMobileOpen(false)} />
            </motion.div>
          </div>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 items-center justify-between border-b border-white/10 bg-slate-950/45 px-4 backdrop-blur-2xl lg:hidden">
            <button onClick={() => setMobileOpen(true)} className="rounded-md border border-white/10 p-2 text-slate-200" aria-label="Open navigation">
              <Menu className="h-5 w-5" />
            </button>
            <div className="text-sm font-semibold text-white">PlanIt Intelligence</div>
            <div className="h-9 w-9" />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            {children}
          </div>
        </main>
      </div>
    </body>
  );
}
