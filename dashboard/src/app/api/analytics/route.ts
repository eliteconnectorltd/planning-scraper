import { NextResponse } from "next/server";
import { getApplicationsPage } from "@/lib/supabase-api";

export async function GET() {
  const { data: records } = await getApplicationsPage({ page: 1, pageSize: 100 });
  const byCouncil = records.reduce<Record<string, number>>((acc, record) => {
    const council = record.council || "Unknown";
    acc[council] = (acc[council] || 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    totalApplications: records.length,
    totalDocuments: records.reduce((sum, record) => sum + (record.documents?.length || 0), 0),
    byCouncil,
  });
}
