import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@clerk/react";
import {
  useListAdvisorHandovers, getListAdvisorHandoversQueryKey,
  useAssignAdvisorHandover, useReplyToAdvisorHandover, useCloseAdvisorHandover,
  getGetAdvisorHandoverQueryKey, useGetAdvisorHandover,
  useResendAdvisorReplyEmail,
} from "@workspace/api-client-react";
import { ArrowLeft, CheckCircle2, Clock3, ExternalLink, Inbox, Loader2, MessageSquare, Send, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useQueryClient } from "@tanstack/react-query";

const statusLabel: Record<string, string> = {
  requested: "Requested",
  assigned: "Assigned",
  replied: "Replied",
  closed: "Closed",
};

export default function Advisor() {
  const { userId } = useAuth();
  const queryClient = useQueryClient();
  const handoversQuery = useListAdvisorHandovers({ query: { queryKey: getListAdvisorHandoversQueryKey(), refetchInterval: 30000 } });
  const assignMutation = useAssignAdvisorHandover();
  const replyMutation = useReplyToAdvisorHandover();
  const resendReplyEmail = useResendAdvisorReplyEmail();
  const closeMutation = useCloseAdvisorHandover();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const selected = handoversQuery.data?.find((handover) => handover.handoverId === selectedId) ?? handoversQuery.data?.[0];
  const assignedToMe = Boolean(selected && selected.assignedAdvisorId === userId);
  const detailQuery = useGetAdvisorHandover(selected?.handoverId ?? "", {
    query: {
      enabled: assignedToMe,
      queryKey: getGetAdvisorHandoverQueryKey(selected?.handoverId ?? ""),
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListAdvisorHandoversQueryKey() });
    if (selected) queryClient.invalidateQueries({ queryKey: getGetAdvisorHandoverQueryKey(selected.handoverId) });
  };

  const assign = (id: string) => assignMutation.mutate({ id, data: { advisorName: "Landa advisor" } }, { onSuccess: refresh });
  const sendReply = (id: string) => {
    if (!reply.trim()) return;
    replyMutation.mutate({ id, data: { reply: reply.trim() } }, { onSuccess: () => { setReply(""); refresh(); } });
  };
  const close = (id: string) => closeMutation.mutate({ id }, { onSuccess: refresh });

  return (
    <div className="flex flex-col flex-1 w-full bg-background theme-advisor animate-fade-in-up">
      <header className="px-4 md:px-8 py-5 border-b border-border/50 bg-card flex items-center justify-between shadow-sm sticky top-0 z-20">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center text-primary border border-primary/30"><Inbox size={22} /></div>
          <div>
            <h1 className="font-serif text-xl font-bold tracking-tight text-foreground">Advisor inbox</h1>
            <p className="text-xs font-bold uppercase tracking-widest text-primary mt-1">Authorized workspace · privacy-minimised context</p>
          </div>
        </div>
        <Link href="/planner"><Button variant="outline" size="sm" className="rounded-full gap-2 font-bold bg-background shadow-sm hover:bg-muted"><ArrowLeft size={16} /> Return to AI</Button></Link>
      </header>
      <div className="p-4 md:p-8 max-w-7xl mx-auto w-full">
        <div className="mb-6 flex items-center justify-between">
          <div><h2 className="font-serif text-2xl font-bold">Handover requests</h2><p className="text-sm text-muted-foreground mt-1">Only authorized advisors can view or respond to these requests.</p></div>
          <Badge variant="outline" className="gap-2"><Clock3 size={13} /> Asynchronous support</Badge>
        </div>
        {handoversQuery.isLoading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" size={18} /> Loading inbox…</div>}
        {handoversQuery.isError && <Card><CardContent className="p-6 text-destructive">The advisor inbox could not be loaded. Confirm your advisor access and try again.</CardContent></Card>}
        {!handoversQuery.isLoading && !handoversQuery.isError && !handoversQuery.data?.length && <Card><CardContent className="p-8 text-center text-muted-foreground">No handover requests yet.</CardContent></Card>}
        {handoversQuery.data && handoversQuery.data.length > 0 && (
          <div className="grid lg:grid-cols-[340px_1fr] gap-6">
            <div className="space-y-3">
              {handoversQuery.data.map((handover) => (
                <button key={handover.handoverId} data-testid={`handover-row-${handover.handoverId}`} onClick={() => setSelectedId(handover.handoverId)} className={`w-full text-left rounded-2xl border p-4 transition-colors ${selected?.handoverId === handover.handoverId ? "border-primary bg-primary/5" : "border-border/60 bg-card hover:border-primary/40"}`}>
                  <div className="flex justify-between gap-2"><span className="font-semibold text-sm">{handover.handoverId}</span><Badge variant="outline">{statusLabel[handover.status]}</Badge></div>
                  <p className="text-xs text-muted-foreground mt-2 line-clamp-2">{handover.summary}</p>
                  <p className="text-[11px] text-muted-foreground mt-3">{new Date(handover.createdAt).toLocaleString()}</p>
                </button>
              ))}
            </div>
            {selected && (
              <Card className="border-border/60">
                <CardHeader><div className="flex justify-between gap-3"><div><CardTitle className="font-serif">Request {selected.handoverId}</CardTitle><p className="text-sm text-muted-foreground mt-1">{selected.savedTripId === null ? "Guest consultation — no account required" : `Saved trip #${selected.savedTripId}`}</p></div><Badge>{statusLabel[selected.status]}</Badge></div></CardHeader>
                <CardContent className="space-y-6">
                  <div className="rounded-xl bg-muted/30 border border-border/50 p-4 text-sm leading-relaxed">{selected.summary}</div>
                   <div className="flex flex-wrap gap-3">
                    <Button data-testid="button-assign-handover" onClick={() => assign(selected.handoverId)} disabled={selected.status !== "requested" || assignMutation.isPending} className="gap-2"><UserRound size={15} /> Assign to me</Button>
                    {assignedToMe && selected.status === "replied" && <Button data-testid="button-close-handover" variant="outline" onClick={() => close(selected.handoverId)} disabled={closeMutation.isPending} className="gap-2"><CheckCircle2 size={15} /> Close request</Button>}
                  </div>
                  {selected.travellerReply && <div className="rounded-xl border border-primary/20 bg-primary/5 p-4"><p className="text-xs font-bold uppercase tracking-wider text-primary mb-2">Reply saved</p><p className="text-sm whitespace-pre-wrap">{selected.travellerReply}</p>
                    {selected.replyNotificationStatus === "accepted" && <p className="mt-2 text-xs">Reply email accepted by provider; delivery is not guaranteed.</p>}
                    {["failed", "not_configured"].includes(selected.replyNotificationStatus ?? "") && <p role="alert" className="mt-2 text-xs text-destructive">Guest reply email is not confirmed. The guest can read the reply in the original planning tab. Use the assigned request's contact email to follow up if necessary.</p>}
                    {assignedToMe && ["failed", "not_configured"].includes(selected.replyNotificationStatus ?? "") && <Button size="sm" variant="outline" className="mt-2" disabled={resendReplyEmail.isPending} onClick={() => resendReplyEmail.mutate({ id: selected.handoverId }, { onSuccess: refresh })}>Retry reply email</Button>}
                    {resendReplyEmail.isError && <p role="alert" className="mt-2 text-xs text-destructive">Email retry could not be confirmed. The saved reply is unchanged.</p>}
                  </div>}
                  {assignedToMe && detailQuery.isLoading && <div className="text-sm text-muted-foreground">Loading shared trip details…</div>}
                  {assignedToMe && detailQuery.isError && <div role="alert" className="text-sm text-destructive">The private handover details could not be loaded. Refresh the inbox and try again.</div>}
                  {assignedToMe && detailQuery.data && (
                    <section className="space-y-4" data-testid={`handover-private-context-${selected.handoverId}`}>
                      <div>
                        <h3 className="text-sm font-bold">Shared trip context</h3>
                         <p className="text-xs text-muted-foreground mt-1">From the traveller’s owned saved trip or active guest conversation; precise location and sensitive free-text accessibility or medical details are excluded. Consented functional access selections are shown.</p>
                        {detailQuery.data.contactEmail && <p className="mt-3 text-sm" data-testid="advisor-guest-contact">Guest reply email: <a className="underline" href={`mailto:${encodeURIComponent(detailQuery.data.contactEmail)}`}>{detailQuery.data.contactEmail}</a></p>}
                        <dl className="mt-3 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                          {Object.entries({
                            Route: [detailQuery.data.context.origin, detailQuery.data.context.destination].filter(Boolean).join(" → "),
                            Dates: detailQuery.data.context.dateRange,
                            Travellers: detailQuery.data.context.travellerCount,
                            Budget: detailQuery.data.context.budget,
                            Transport: detailQuery.data.context.transportPreferences.join(", "),
                            Accommodation: detailQuery.data.context.accommodationNeeds.join(", "),
                            Activities: detailQuery.data.context.activityPreferences?.join(", "),
                            Stopovers: detailQuery.data.context.stopovers.join(", "),
                             Accessibility: detailQuery.data.context.accessibilityNeeds.length ? detailQuery.data.context.accessibilityNeeds.join(", ") : "None selected",
                            Sustainability: detailQuery.data.context.sustainabilityPriority,
                          }).filter(([, value]) => value != null && value !== "").map(([label, value]) => (
                            <div key={label}><dt className="inline font-semibold">{label}: </dt><dd className="inline text-muted-foreground">{value}</dd></div>
                          ))}
                        </dl>
                      </div>
                      <div className="border-t border-border/60 pt-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <h3 className="text-sm font-bold">Confirmed recommendation options</h3>
                            <p className="text-xs text-muted-foreground mt-1">Displayed options and provenance from this conversation’s latest confirmed results.</p>
                          </div>
                          {detailQuery.data.context.recommendationSource && (
                            <Badge variant="outline">{detailQuery.data.context.recommendationSource === "live" ? "Live provider results" : "Demo / curated results"}</Badge>
                          )}
                        </div>
                        {detailQuery.data.context.recommendationConfirmedAt && (
                          <p className="mt-2 text-xs text-muted-foreground">Confirmed {detailQuery.data.context.recommendationConfirmedAt.toLocaleString()}</p>
                        )}
                        <div className="mt-3 space-y-3">
                          {(detailQuery.data.context.recommendationOptions ?? []).length === 0 && (
                            <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">No confirmed recommendation snapshot was available when this handover was prepared.</p>
                          )}
                          {(detailQuery.data.context.recommendationOptions ?? []).map((option) => {
                            const explicitlySelected = (detailQuery.data.context.selectedRecommendationIds ?? []).includes(option.id);
                            const evidence = option.certificationEvidence;
                            const sourceIsUrl = /^https:\/\//i.test(option.source);
                            return (
                              <article key={option.id} data-testid={`advisor-recommendation-${option.id}`} className="rounded-xl border border-border/60 bg-muted/20 p-4">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Badge variant="secondary" className="uppercase">{option.type}</Badge>
                                      <h4 className="font-semibold">{option.name}</h4>
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">{option.location}</p>
                                  </div>
                                  <Badge variant={explicitlySelected ? "default" : "outline"}>
                                    {explicitlySelected ? "Traveller selected" : "Presented option"}
                                  </Badge>
                                </div>
                                <p className="mt-3 text-sm leading-relaxed">{option.description}</p>
                                <dl className="mt-3 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
                                  <div><dt className="inline font-semibold">Price: </dt><dd className="inline text-muted-foreground">{option.price}</dd></div>
                                  <div><dt className="inline font-semibold">Estimated carbon: </dt><dd className="inline text-muted-foreground">{option.carbonKg == null ? "Not available" : `${option.carbonKg} kg CO₂e (${option.carbonLabel ?? "label unavailable"})`}</dd></div>
                                  <div><dt className="inline font-semibold">Rank score: </dt><dd className="inline text-muted-foreground">{option.score}</dd></div>
                                  {option.durationMinutes !== undefined && <div><dt className="inline font-semibold">Provider journey time: </dt><dd className="inline text-muted-foreground">{Math.round(option.durationMinutes)} minutes</dd></div>}
                                  {option.connectionCount !== undefined && <div><dt className="inline font-semibold">Connections: </dt><dd className="inline text-muted-foreground">{option.connectionCount}</dd></div>}
                                  <div className="sm:col-span-2"><dt className="inline font-semibold">Option source: </dt><dd className="inline text-muted-foreground">{sourceIsUrl ? <a href={option.source} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">{option.source} <ExternalLink className="inline" size={11} /></a> : option.source}</dd></div>
                                  <div className="sm:col-span-2"><dt className="inline font-semibold">Source checked: </dt><dd className="inline text-muted-foreground">{new Date(option.verifiedAt).toLocaleString()}</dd></div>
                                </dl>
                                {option.rankingExplanation && (
                                  <p className="mt-3 rounded-lg bg-background/70 p-3 text-xs leading-relaxed"><strong>Ranking explanation: </strong>{option.rankingExplanation}</p>
                                )}
                                {evidence ? (
                                  <div className="mt-3 rounded-lg border border-primary/15 bg-primary/5 p-3 text-xs">
                                    <p className="font-semibold">Certification evidence: {evidence.scheme}</p>
                                    <p className="mt-1 text-muted-foreground">Licence {evidence.licenceNumber} · valid until {new Date(evidence.validUntil).toLocaleDateString()} · checked {new Date(evidence.checkedAt).toLocaleDateString()}</p>
                                    <a href={evidence.registryUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-primary underline underline-offset-2">Registry record <ExternalLink size={11} /></a>
                                  </div>
                                ) : option.certification ? (
                                  <p className="mt-3 text-xs text-muted-foreground">Certification claim (“{option.certification}”) has no current registry evidence attached.</p>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
                        <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                          <p className="text-xs font-bold uppercase tracking-wider">Unknowns and limitations</p>
                          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
                            {(detailQuery.data.context.recommendationUnknowns ?? ["Recommendation source and availability are not recorded."]).map((unknown, index) => <li key={`${index}-${unknown}`}>{unknown}</li>)}
                          </ul>
                          <p className="mt-3 text-xs"><strong>Selection status: </strong>{detailQuery.data.context.recommendationSelectionStatus === "explicit_selection" ? "The traveller explicitly selected the options marked above." : "No explicit recommendation selection was recorded; all options above were presented for advisor review."}</p>
                        </div>
                      </div>
                      <div>
                        <h3 className="text-sm font-bold">Redacted conversation</h3>
                        <div className="mt-2 max-h-80 space-y-3 overflow-y-auto rounded-xl border border-border/60 bg-muted/20 p-4">
                          {detailQuery.data.transcript.length === 0 && <p className="text-sm text-muted-foreground">No conversation turns were shared.</p>}
                          {detailQuery.data.transcript.map((turn, index) => (
                            <div key={`${turn.role}-${index}`} className="text-sm" data-testid={`transcript-turn-${index}`}>
                              <p className="text-[10px] font-bold uppercase tracking-wider text-primary">{turn.role === "user" ? "Traveller" : "Assistant"}</p>
                              <p className="mt-1 whitespace-pre-wrap">{turn.content}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </section>
                  )}
                  {assignedToMe && selected.status === "assigned" && <div className="space-y-3"><label htmlFor="advisor-reply" className="text-sm font-semibold flex items-center gap-2"><MessageSquare size={16} /> Reply to traveller</label><Textarea id="advisor-reply" data-testid="textarea-advisor-reply" value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Share the next practical step, evidence, or clarification…" maxLength={4000} /><Button data-testid="button-send-advisor-reply" onClick={() => sendReply(selected.handoverId)} disabled={!reply.trim() || replyMutation.isPending} className="gap-2"><Send size={15} /> Send reply</Button></div>}
                  {selected.status === "assigned" && !assignedToMe && <p className="text-sm text-muted-foreground">Private trip context and transcript are visible only to the advisor assigned to this request.</p>}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}