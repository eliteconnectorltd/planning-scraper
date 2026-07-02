import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  FileText,
  LayoutDashboard,
  Menu,
  ScrollText,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import { getApplicationsPage } from "@/lib/planning-api";

type ShellStats = {
  applications: number;
  documents: number;
  councils: number;
};

const navItems = [
  { href: "/", label: "Overview", icon: Activity },
  { href: "/applications", label: "Applications", icon: FileText },
  { href: "/changes", label: "Changes", icon: Sparkles },
  { href: "/runs", label: "Runs", icon: ScrollText },
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
  const pathname = useLocation().pathname;

  return (
    <aside className={`relative flex h-full flex-col border-r border-border bg-card transition-all duration-200 ${collapsed ? "w-[68px]" : "w-[248px]"}`}>
      <div className="flex h-16 items-center gap-2.5 border-b border-border px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-foreground">
          <LayoutDashboard className="h-4 w-4" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">Planning Intelligence</div>
            <div className="truncate text-xs text-muted-foreground">Application monitor</div>
          </div>
        )}
        {mobileClose && (
          <button onClick={mobileClose} className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-secondary lg:hidden" aria-label="Close navigation">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-1 px-2 py-3">
        {navItems.map(item => {
          const Icon = item.icon;
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              to={item.href}
              title={collapsed ? item.label : undefined}
              onClick={mobileClose}
              className={`relative flex min-h-10 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />}
              <Icon className={`h-4 w-4 shrink-0 ${active ? "text-primary" : "text-muted-foreground"}`} />
              {!collapsed && item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        <div className={`grid gap-2 ${collapsed ? "grid-cols-1" : "grid-cols-3"}`}>
          {[
            { label: "Apps", value: stats.applications },
            { label: "Docs", value: stats.documents },
            { label: "Councils", value: stats.councils },
          ].map(stat => (
            <div key={stat.label} className="rounded-md border border-border bg-background px-2 py-1.5">
              <div className="text-sm font-semibold tabular-nums text-foreground">{formatCompact(stat.value)}</div>
              {!collapsed && <div className="text-[11px] text-muted-foreground">{stat.label}</div>}
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={onToggle}
        className="absolute -right-3 top-20 hidden h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground lg:flex"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
      </button>
    </aside>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // The old App Router root layout fetched these stats server-side and passed
  // them to AppShell. In the SPA the shell fetches them itself; TanStack Query
  // caches the result across navigations. (Separate queryKey from the Overview
  // page — see CONVERSION_LOG.md → Followups for the minor double-fetch note.)
  const { data } = useQuery({
    queryKey: ["layout-stats"],
    queryFn: () => getApplicationsPage({ page: 1, pageSize: 100 }),
  });
  const stats: ShellStats = {
    applications: data?.count || data?.data.length || 0,
    documents: (data?.data || []).reduce((total, record) => total + (record.documents?.length || 0), 0),
    councils: new Set((data?.data || []).map(record => record.council).filter(Boolean)).size,
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex h-dvh overflow-hidden">
        <div className="hidden lg:block">
          <SidebarContent collapsed={collapsed} onToggle={() => setCollapsed(value => !value)} stats={stats} />
        </div>

        {mobileOpen && (
          <div className="fixed inset-0 z-50 flex lg:hidden">
            <button className="absolute inset-0 bg-black/35 backdrop-blur-[1px]" onClick={() => setMobileOpen(false)} aria-label="Close navigation overlay" />
            <div className="relative z-10 h-full max-w-[86vw]">
              <SidebarContent collapsed={false} onToggle={() => setCollapsed(value => !value)} stats={stats} mobileClose={() => setMobileOpen(false)} />
            </div>
          </div>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-card/95 px-4 backdrop-blur lg:hidden">
            <button onClick={() => setMobileOpen(true)} className="icon-button" aria-label="Open navigation">
              <Menu className="h-5 w-5" />
            </button>
            <div className="text-sm font-semibold text-foreground">Planning Intelligence</div>
            <div className="h-8 w-8" />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto scroll-smooth">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
