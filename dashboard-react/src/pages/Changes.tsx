import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getChangeFeed } from "@/lib/planning-api";
import { Loading } from "@/components/loading";

const chip = "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium";

export default function Changes() {
  // Reads from Supabase. getChangeFeed already returns newest-first.
  const { data: result, isLoading } = useQuery({
    queryKey: ["changes"],
    queryFn: () => getChangeFeed({ page: 1, pageSize: 100 }),
  });

  if (isLoading) return <Loading />;
  const changeLog = result?.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-5 px-6 py-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Changes</h1>
        <p className="mt-1 text-sm text-muted-foreground">Detected application, document, decision, and hash changes across tracked councils.</p>
      </header>

      {changeLog.length === 0 ? (
        <div className="card-surface flex min-h-[240px] flex-col items-center justify-center p-10 text-center">
          <h2 className="text-base font-semibold text-foreground">No changes recorded</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">New applications, document additions, and decision movements appear after scraper runs complete.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {changeLog.map((log) => {
            const date = new Date(log.run_at);
            const totalChanges = log.summary.new_applications + log.summary.new_documents + log.summary.updated_decisions + log.summary.changed_hashes;

            return (
              <div key={log.run_id} className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono text-foreground">{log.run_id.substring(0, 8)}</span>
                  <span>·</span>
                  <span>{date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  <span>·</span>
                  <span>{totalChanges} change{totalChanges === 1 ? "" : "s"}</span>
                </div>

                <div className="card-surface divide-y divide-border">
                  {log.changes?.new_applications?.map((app) => (
                    <div key={app.application_id || app.council || "new-application"} className="flex items-start gap-3 px-4 py-3">
                      <span className={`${chip} border-green-200 bg-green-50 text-green-700`}>New application</span>
                      <div className="min-w-0">
                        <Link to={`/applications/${encodeURIComponent(app.application_id || "")}`} className="font-medium text-primary hover:underline">
                          {app.application_id || "Unknown application"}
                        </Link>
                        <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{app.proposal}</p>
                      </div>
                    </div>
                  ))}

                  {log.changes?.updated_decisions?.map((update) => (
                    <div key={update.application_id || update.new_decision || "decision-update"} className="flex items-start gap-3 px-4 py-3">
                      <span className={`${chip} border-amber-200 bg-amber-50 text-amber-700`}>Decision updated</span>
                      <div className="min-w-0">
                        <Link to={`/applications/${encodeURIComponent(update.application_id || "")}`} className="font-medium text-primary hover:underline">
                          {update.application_id || "Unknown application"}
                        </Link>
                        <div className="mt-0.5 flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground line-through">{update.previous_decision || "PENDING"}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="font-medium text-foreground">{update.new_decision}</span>
                        </div>
                      </div>
                    </div>
                  ))}

                  {log.changes?.new_documents?.map((doc, i: number) => (
                    <div key={i} className="flex items-start gap-3 px-4 py-3">
                      <span className={`${chip} border-blue-200 bg-blue-50 text-blue-700`}>New document</span>
                      <div className="min-w-0">
                        <Link to={`/applications/${encodeURIComponent(doc.application_id || "")}`} className="font-medium text-primary hover:underline">
                          {doc.application_id || "Unknown application"}
                        </Link>
                        <p className="mt-0.5 text-sm text-muted-foreground">{doc.filename || doc.type || doc.url}</p>
                      </div>
                    </div>
                  ))}

                  {log.changes?.changed_hashes?.map((hashObj, i: number) => (
                    <div key={i} className="flex items-start gap-3 px-4 py-3">
                      <span className={`${chip} border-red-200 bg-red-50 text-red-700`}>File modified</span>
                      <div className="min-w-0">
                        <Link to={`/applications/${encodeURIComponent(hashObj.application_id || "")}`} className="font-medium text-primary hover:underline">
                          {hashObj.application_id || "Unknown application"}
                        </Link>
                        <p className="mt-0.5 text-sm text-muted-foreground">{hashObj.filename} hash changed unexpectedly.</p>
                      </div>
                    </div>
                  ))}

                  {totalChanges === 0 && (
                    <div className="px-4 py-3 text-sm italic text-muted-foreground">
                      Scrape completed but no material changes were detected.
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
