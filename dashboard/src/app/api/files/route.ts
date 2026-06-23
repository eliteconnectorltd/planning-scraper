import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";

const PROJECT_ROOT = path.resolve(process.cwd(), "..");
const OUTPUT_ROOT = path.join(PROJECT_ROOT, "output");

export async function GET(request: NextRequest) {
  const rawPath = request.nextUrl.searchParams.get("path");
  if (!rawPath) {
    return NextResponse.json({ error: "Missing file path" }, { status: 400 });
  }

  const resolvedPath = path.resolve(PROJECT_ROOT, rawPath);
  const outputRootWithSeparator = OUTPUT_ROOT.endsWith(path.sep) ? OUTPUT_ROOT : `${OUTPUT_ROOT}${path.sep}`;

  if (!resolvedPath.startsWith(outputRootWithSeparator) || !fs.existsSync(resolvedPath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const file = fs.readFileSync(resolvedPath);
  const filename = path.basename(resolvedPath);

  return new NextResponse(file, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
}
