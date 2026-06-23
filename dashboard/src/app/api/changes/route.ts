import { NextRequest, NextResponse } from "next/server";
import { getChangeFeed } from "@/lib/supabase-api";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const result = await getChangeFeed({
    page: params.get("page") || 1,
    pageSize: params.get("pageSize") || 25,
  });
  return NextResponse.json(result);
}
