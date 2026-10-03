import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Download, FileText, Loader2, LockKeyhole, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";

type Application = {
  id: number;
  name: string;
  email: string;
  details: string;
  cvFileName: string;
  cvSize: number;
  createdAt: string;
  retentionExpiresAt: string;
  cvDownloadUrl: string;
};

export default function RecruitmentApplications() {
  const { getToken } = useAuth();
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const token = await getToken();
        const response = await fetch(`${import.meta.env.BASE_URL}api/admin/recruitment/applications`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Applications could not be loaded.");
        if (active) setApplications(body);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Applications could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [getToken]);

  return (
    <div className="container max-w-5xl mx-auto px-4 md:px-6 py-16 flex-1">
      <div className="flex items-start gap-4 mb-10">
        <div className="p-3 rounded-xl bg-primary/10 text-primary"><LockKeyhole /></div>
        <div>
          <h1 className="text-4xl md:text-5xl font-serif font-bold">Contributor Applications</h1>
          <p className="text-muted-foreground mt-2">Private recruitment records available only to the founder.</p>
        </div>
      </div>

      {loading && <div className="flex items-center gap-3 text-muted-foreground"><Loader2 className="animate-spin" /> Loading applications…</div>}
      {error && <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-destructive">{error}</div>}
      {!loading && !error && applications.length === 0 && (
        <div className="rounded-2xl border border-border/60 bg-card/40 p-10 text-center">
          <FileText className="mx-auto mb-4 text-primary" />
          <h2 className="text-xl font-bold">No applications yet</h2>
          <p className="text-muted-foreground mt-2">New submissions from the Team page will appear here.</p>
        </div>
      )}

      <div className="space-y-5">
        {applications.map((application) => (
          <article key={application.id} className="rounded-2xl border border-border/60 bg-card/40 p-6 md:p-8">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-5">
              <div>
                <h2 className="text-2xl font-serif font-bold">{application.name}</h2>
                <a href={`mailto:${application.email}`} className="inline-flex items-center gap-2 text-primary mt-2 hover:underline">
                  <Mail size={16} /> {application.email}
                </a>
                <p className="text-xs text-muted-foreground mt-2">
                  Submitted {new Date(application.createdAt).toLocaleString()}
                </p>
              </div>
              <Button asChild variant="outline">
                <a href={application.cvDownloadUrl} target="_blank" rel="noreferrer">
                  <Download size={16} className="mr-2" /> Download CV
                </a>
              </Button>
            </div>
            <div className="mt-6 whitespace-pre-wrap text-muted-foreground leading-relaxed">{application.details}</div>
            <div className="mt-6 pt-4 border-t border-border/60 text-xs text-muted-foreground flex flex-wrap gap-x-6 gap-y-2">
              <span>{application.cvFileName} · {(application.cvSize / 1024).toFixed(1)} KB</span>
              <span>Retention date: {new Date(application.retentionExpiresAt).toLocaleDateString()}</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}