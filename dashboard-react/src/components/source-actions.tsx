import { Check, Copy, ExternalLink, FileText } from "lucide-react";
import { useState } from "react";

type SourceActionsProps = {
  sourceUrl?: string;
  planitUrl?: string;
  documentsUrl?: string;
};

const btn = "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-border-strong hover:bg-secondary";

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
          <button type="button" onClick={() => openUrl(sourceUrl)} className={btn}>
            <ExternalLink className="h-4 w-4 text-muted-foreground" />
            Open source
          </button>
          <button type="button" onClick={() => copyUrl("source", sourceUrl)} className={btn}>
            {copied === "source" ? <Check className="h-4 w-4 text-muted-foreground" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
            {copied === "source" ? "Copied" : "Copy source"}
          </button>
        </>
      )}
      {documentsUrl && (
        <button type="button" onClick={() => openUrl(documentsUrl)} className={btn}>
          <FileText className="h-4 w-4 text-muted-foreground" />
          Open documents
        </button>
      )}
      {planitUrl && (
        <>
          <button type="button" onClick={() => openUrl(planitUrl)} className={btn}>
            <ExternalLink className="h-4 w-4 text-muted-foreground" />
            Open PlanIt
          </button>
          <button type="button" onClick={() => copyUrl("planit", planitUrl)} className={btn}>
            {copied === "planit" ? <Check className="h-4 w-4 text-muted-foreground" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
            {copied === "planit" ? "Copied" : "Copy PlanIt"}
          </button>
        </>
      )}
    </div>
  );
}
