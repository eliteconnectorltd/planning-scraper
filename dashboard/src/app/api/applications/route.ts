import { NextRequest, NextResponse } from "next/server";
import { getApplicationsPage } from "@/lib/supabase-api";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const result = await getApplicationsPage({
    page: params.get("page") || 1,
    pageSize: params.get("pageSize") || 25,
    q: params.get("q") || undefined,
    council: params.get("council") || undefined,
    decision: params.get("decision") || undefined,
  });
  return NextResponse.json(result);
}
