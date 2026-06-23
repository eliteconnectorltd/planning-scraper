import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { getApplicationsPage } from "@/lib/supabase-api";

export const metadata: Metadata = {
  title: "Planning Intelligence Platform",
  description: "AI-powered planning application tracking and intelligence.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { data, count } = await getApplicationsPage({ page: 1, pageSize: 100 }).catch(() => ({ data: [], count: 0 }));
  const stats = {
    applications: count || data.length,
    documents: data.reduce((total, record) => total + (record.documents?.length || 0), 0),
    councils: new Set(data.map(record => record.council).filter(Boolean)).size,
  };

  return (
    <html lang="en" className="dark">
      <AppShell stats={stats}>{children}</AppShell>
    </html>
  );
}
