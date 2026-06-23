import { getChangeFeed } from "@/lib/supabase-api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GitCommit, FileText, CheckCircle, AlertTriangle, PlusCircle } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ChangesPage() {
  // Reads from Supabase when populated, falling back to local JSON.
  // getChangeFeed already returns newest-first, so no .reverse() needed.
  const { data: changeLog } = await getChangeFeed({ page: 1, pageSize: 100 });

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-5 py-6 sm:px-8 lg:px-10">
      <div>
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-medium text-cyan-200">
          <GitCommit className="h-3.5 w-3.5" />
          Change intelligence
        </div>
        <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">Changes Feed</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">Chronological history of detected application, document, decision, and hash changes across tracked councils.</p>
      </div>

      <div className="space-y-12">
        {changeLog.length === 0 ? (
          <div className="glass-panel flex min-h-[320px] flex-col items-center justify-center rounded-xl p-10 text-center">
            <GitCommit className="mb-4 h-10 w-10 text-cyan-300" />
            <h2 className="text-lg font-semibold text-white">No changes recorded</h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">New applications, document additions, and decision movements will appear after scraper runs complete.</p>
          </div>
        ) : (
          changeLog.map((log) => {
            const date = new Date(log.run_at);
            const totalChanges = log.summary.new_applications + log.summary.new_documents + log.summary.updated_decisions + log.summary.changed_hashes;

            return (
              <div key={log.run_id} className="relative pl-6 md:pl-0">
                {/* Desktop Date Gutter */}
                <div className="hidden md:block absolute left-0 top-0 w-32 text-right pr-8">
                  <div className="text-sm font-semibold text-white/90">{date.toLocaleDateString()}</div>
                  <div className="text-xs text-white/40">{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                </div>

                {/* Timeline Line */}
                <div className="absolute left-0 md:left-32 top-0 bottom-0 w-px bg-white/10" />

                {/* Main Content Area */}
                <div className="md:pl-40 relative pb-12">
                  <div className="absolute -left-[5px] md:left-[123px] top-1 w-3 h-3 rounded-full bg-cyan-400 border-2 border-slate-950 shadow-[0_0_16px_rgba(34,211,238,0.5)]" />
                  
                  <div className="flex items-center gap-3 mb-4">
                    <Badge variant="outline" className="bg-white/5 border-white/10 text-white/60 font-mono text-xs">
                      <GitCommit className="w-3 h-3 mr-1 inline" />
                      {log.run_id.substring(0, 8)}
                    </Badge>
                    <span className="text-sm text-white/40">{totalChanges} changes detected</span>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    {/* New Applications */}
                    {log.changes?.new_applications?.map((app) => (
                      <Card key={app.application_id || app.council || 'new-application'} className="bg-emerald-500/5 border-emerald-500/20">
                        <CardContent className="p-4 flex gap-4 items-start">
                          <div className="mt-1 bg-emerald-500/20 p-2 rounded-full">
                            <PlusCircle className="w-4 h-4 text-emerald-400" />
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-1">New Application</div>
                            <Link href={`/applications/${encodeURIComponent(app.application_id || '')}`} className="font-medium text-white/90 hover:text-emerald-300 transition-colors">
                              {app.application_id || 'Unknown application'}
                            </Link>
                            <p className="text-sm text-white/60 mt-1 line-clamp-2">{app.proposal}</p>
                          </div>
                        </CardContent>
                      </Card>
                    ))}

                    {/* Updated Decisions */}
                    {log.changes?.updated_decisions?.map((update) => (
                      <Card key={update.application_id || update.new_decision || 'decision-update'} className="bg-amber-500/5 border-amber-500/20">
                        <CardContent className="p-4 flex gap-4 items-start">
                          <div className="mt-1 bg-amber-500/20 p-2 rounded-full">
                            <CheckCircle className="w-4 h-4 text-amber-400" />
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-1">Decision Updated</div>
                            <Link href={`/applications/${encodeURIComponent(update.application_id || '')}`} className="font-medium text-white/90 hover:text-amber-300 transition-colors">
                              {update.application_id || 'Unknown application'}
                            </Link>
                            <div className="text-sm mt-1 flex items-center gap-2">
                              <span className="text-white/40 line-through">{update.previous_decision || 'PENDING'}</span>
                              <span className="text-white/60">-&gt;</span>
                              <span className="text-amber-400 font-medium">{update.new_decision}</span>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}

                    {/* New Documents */}
                    {log.changes?.new_documents?.map((doc, i: number) => (
                      <Card key={i} className="bg-indigo-500/5 border-indigo-500/20">
                        <CardContent className="p-4 flex gap-4 items-start">
                          <div className="mt-1 bg-indigo-500/20 p-2 rounded-full">
                            <FileText className="w-4 h-4 text-indigo-400" />
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-indigo-400 uppercase tracking-wider mb-1">New Document Added</div>
                            <Link href={`/applications/${encodeURIComponent(doc.application_id || '')}`} className="font-medium text-white/90 hover:text-indigo-300 transition-colors">
                              {doc.application_id || 'Unknown application'}
                            </Link>
                            <p className="text-sm text-white/60 mt-1">{doc.filename || doc.type || doc.url}</p>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                    
                    {/* Changed Hashes */}
                    {log.changes?.changed_hashes?.map((hashObj, i: number) => (
                      <Card key={i} className="bg-red-500/5 border-red-500/20">
                        <CardContent className="p-4 flex gap-4 items-start">
                          <div className="mt-1 bg-red-500/20 p-2 rounded-full">
                            <AlertTriangle className="w-4 h-4 text-red-400" />
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-1">File Modified</div>
                            <Link href={`/applications/${encodeURIComponent(hashObj.application_id || '')}`} className="font-medium text-white/90 hover:text-red-300 transition-colors">
                              {hashObj.application_id || 'Unknown application'}
                            </Link>
                            <p className="text-sm text-white/60 mt-1">{hashObj.filename} hash changed unexpectedly.</p>
                          </div>
                        </CardContent>
                      </Card>
                    ))}

                    {totalChanges === 0 && (
                      <div className="col-span-full py-4 text-sm text-white/40 italic">
                        Scrape completed but no material changes were detected.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
