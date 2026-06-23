"use client";

import { Check, Copy, ExternalLink, FileText } from "lucide-react";
import { useState } from "react";

type SourceActionsProps = {
  sourceUrl?: string;
  planitUrl?: string;
  documentsUrl?: string;
};

export function SourceActions({ sourceUrl, planitUrl, documentsUrl }: SourceActionsProps) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copyUrl(label: string, url?: string) {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1800);
  }

  function openUrl(url?: string) {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="flex flex-wrap gap-2">
      {sourceUrl && (
        <>
          <button type="button" onClick={() => openUrl(sourceUrl)} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-sm font-medium text-white transition hover:border-cyan-300/40 hover:bg-cyan-300/10">
            <ExternalLink className="h-4 w-4" />
            Open Source
          </button>
          <button type="button" onClick={() => copyUrl("source", sourceUrl)} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-sm font-medium text-white transition hover:border-cyan-300/40 hover:bg-cyan-300/10">
            {copied === "source" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied === "source" ? "Copied" : "Copy Source"}
          </button>
        </>
      )}
      {documentsUrl && (
        <button type="button" onClick={() => openUrl(documentsUrl)} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-sm font-medium text-white transition hover:border-violet-300/40 hover:bg-violet-300/10">
          <FileText className="h-4 w-4" />
          Open Documents
        </button>
      )}
      {planitUrl && (
        <>
          <button type="button" onClick={() => openUrl(planitUrl)} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-sm font-medium text-white transition hover:border-emerald-300/40 hover:bg-emerald-300/10">
            <ExternalLink className="h-4 w-4" />
            Open PlanIt
          </button>
          <button type="button" onClick={() => copyUrl("planit", planitUrl)} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-sm font-medium text-white transition hover:border-emerald-300/40 hover:bg-emerald-300/10">
            {copied === "planit" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied === "planit" ? "Copied" : "Copy PlanIt"}
          </button>
        </>
      )}
    </div>
  );
}
