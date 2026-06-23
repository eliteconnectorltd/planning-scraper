import { NextResponse } from "next/server";
import { getApplicationsPage } from "@/lib/supabase-api";

export async function GET() {
  const { data } = await getApplicationsPage({ page: 1, pageSize: 100 });
  return NextResponse.json(data);
}
