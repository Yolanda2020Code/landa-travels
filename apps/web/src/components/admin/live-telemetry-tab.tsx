import { useState, useMemo } from 'react';
import { 
  useGetAdminChatbotOverview,
  useGetAdminChatbotFunnel,
  useListAdminChatbotFailures,
  useListAdminChatbotConversations,
  useGetAdminChatbotConversation,
  useCreateAdminChatbotReview,
  getGetAdminChatbotConversationQueryKey
} from '@workspace/api-client-react';
import type {
  AdminConversationFailureClassParameter,
  AdminSourceParameter,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Search, Loader2, MessageSquare, AlertTriangle, ArrowRight, ShieldAlert } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MetricsCharts } from './metrics-charts';

function KPICard({ title, value, state, subtitle, testId }: { title: string, value: string | number, state?: string, subtitle?: string, testId?: string }) {
  return (
    <Card data-testid={testId} className="bg-card border-border/50 shadow-sm relative overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-serif font-bold text-foreground" data-testid={`${testId}-value`}>
          {state === 'insufficient_sample' ? '-' : value}
        </div>
        {subtitle && (
          <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>
        )}
        {state === 'insufficient_sample' && (
          <div className="text-xs text-amber-500/80 mt-1 flex items-center gap-1" data-testid={`${testId}-insufficient`}>
            <AlertTriangle size={12} /> Insufficient sample
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ConversationDrilldown({ sessionId, open, onOpenChange }: { sessionId: string | null, open: boolean, onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetAdminChatbotConversation(sessionId || '', { query: { enabled: !!sessionId && open, queryKey: getGetAdminChatbotConversationQueryKey(sessionId || '') } });
  
  const createReview = useCreateAdminChatbotReview();
  const [label, setLabel] = useState('');
  
  const handleReview = () => {
    if (!sessionId || !label) return;
    createReview.mutate({ data: { sessionId, label } }, {
      onSuccess: () => {
        // Optimistic UI or cache invalidate
        queryClient.invalidateQueries({ queryKey: getGetAdminChatbotConversationQueryKey(sessionId) });
        setLabel('');
        onOpenChange(false);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-conversation-drilldown" className="max-w-4xl h-[85vh] flex flex-col p-0 gap-0 overflow-hidden bg-background">
        <DialogHeader className="p-6 border-b border-border/50 bg-muted/20 shrink-0">
          <DialogTitle className="font-serif text-2xl flex items-center gap-3">
            <MessageSquare className="text-primary" />
            Transcript Drilldown
            {sessionId && <span data-testid="text-drilldown-session-id" className="text-sm font-mono font-normal text-muted-foreground ml-2">{sessionId}</span>}
          </DialogTitle>
        </DialogHeader>
        
        {isLoading ? (
          <div data-testid="status-drilldown-loading" className="flex-1 flex items-center justify-center text-muted-foreground">
            <Loader2 className="animate-spin w-8 h-8 opacity-50" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            <div data-testid="alert-privacy-filter" className="bg-amber-500/10 text-amber-500 border border-amber-500/20 px-4 py-3 rounded-lg text-sm flex gap-3 mb-6">
              <AlertTriangle className="shrink-0" size={16} />
              <div>
                <strong>Privacy Filter Active.</strong> PII has been redacted from this transcript. Metadata is truncated.
              </div>
            </div>
            
            {((data as any)?.turns || []).map((turn: any) => (
              <div key={turn.id} className={`flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                  turn.role === 'user' 
                    ? 'bg-primary text-primary-foreground rounded-tr-sm' 
                    : 'bg-muted border border-border/50 text-foreground rounded-tl-sm'
                }`}>
                  <div className="text-xs opacity-70 mb-1 uppercase tracking-wider font-bold">{turn.role}</div>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">{turn.content || '[Content redacted or empty]'}</div>
                </div>
              </div>
            ))}
            {((data as any)?.turns || []).length === 0 && (
              <div className="text-center text-muted-foreground py-8">No conversation turns found.</div>
            )}
          </div>
        )}

        <div className="p-6 border-t border-border/50 bg-muted/10 shrink-0">
          <h4 className="font-bold text-sm mb-3">Label Conversation</h4>
          <div className="flex gap-4">
            <div className="flex-1">
              <Input 
                data-testid="input-review-label"
                placeholder="Outcome / Label (e.g. success, hallucination, off_topic)" 
                value={label} 
                onChange={e => setLabel(e.target.value)} 
                className="bg-background mb-3"
              />
            </div>
            <div className="flex items-end">
              <Button 
                data-testid="button-submit-review"
                onClick={handleReview} 
                disabled={!label || createReview.isPending}
                className="font-bold"
              >
                {createReview.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Submit Label
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function LiveTelemetryTab({ dateRange }: { dateRange: string }) {
  const { from, to } = useMemo(() => {
    if (dateRange === 'all') return { from: undefined, to: undefined };
    const now = new Date();
    const toDate = now.toISOString().split('T')[0];
    let days = 7;
    if (dateRange === 'today') days = 1;
    if (dateRange === '30d') days = 30;
    const fromD = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    const fromDate = fromD.toISOString().split('T')[0];
    return { from: fromDate, to: toDate };
  }, [dateRange]);

  const { data: overview, isLoading: isOverviewLoading, error: overviewError } = useGetAdminChatbotOverview({ from, to });
  const { data: funnel, isLoading: isFunnelLoading } = useGetAdminChatbotFunnel({ from, to });
  const { data: failures, isLoading: isFailuresLoading } = useListAdminChatbotFailures({ from, to });
  
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<AdminSourceParameter | 'all'>('all');
  const [outcomeFilter, setOutcomeFilter] = useState<string>('all');
  const [failureFilter, setFailureFilter] = useState<AdminConversationFailureClassParameter | 'all'>('all');
  const [page, setPage] = useState(0);
  const limit = 50;

  const { data: conversations, isLoading: isConversationsLoading } = useListAdminChatbotConversations(
    { 
      q: search || undefined, 
      limit, 
      offset: page * limit,
      from, 
      to,
      source: sourceFilter === 'all' ? undefined : sourceFilter,
      outcome: outcomeFilter === 'all' ? undefined : outcomeFilter,
      failureClass: failureFilter === 'all' ? undefined : failureFilter
    }
  );

  const [drilldownId, setDrilldownId] = useState<string | null>(null);

  const metrics = (overview as any)?.metrics;
  const sourceBreakdown = (overview as any)?.sourceBreakdown || [];
  const dailyTrend = (overview as any)?.dailyTimeSeries || [];
  const funnelStages = (funnel as any)?.slotDropoff || [];
  const failureCohorts = (failures as any)?.cohorts || [];
  const convoRows = (conversations as any)?.rows || [];

  if (overviewError && (overviewError as any).status === 403) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground bg-card border border-border/50 rounded-xl mt-6">
        <ShieldAlert size={48} className="mb-4 text-destructive opacity-80" />
        <h3 className="text-xl font-bold text-foreground mb-2">Access Denied</h3>
        <p>You do not have the required administrator privileges to view this dashboard.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 mt-6 animate-in fade-in duration-500">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard 
          title="Total Volume" 
          value={metrics?.volume?.value || 0} 
          state={metrics?.volume?.state}
          subtitle="Sessions processed"
          testId="kpi-volume"
        />
        <KPICard 
          title="Completion Rate" 
          value={`${((metrics?.completionRate?.value || 0) * 100).toFixed(1)}%`} 
          state={metrics?.completionRate?.state}
          subtitle={`From ${metrics?.completionRate?.sampleSize || 0} sessions`}
          testId="kpi-completion"
        />
        <KPICard 
          title="Fallback Rate" 
          value={`${((metrics?.fallbackRate?.value || 0) * 100).toFixed(1)}%`} 
          state={metrics?.fallbackRate?.state}
          subtitle="Triggered unhandled fallback"
          testId="kpi-fallback"
        />
        <KPICard 
          title="Unresolved Rate" 
          value={`${((metrics?.unresolvedRate?.value || 0) * 100).toFixed(1)}%`} 
          state={metrics?.unresolvedRate?.state}
          subtitle="Unresolved intents"
          testId="kpi-unresolved"
        />
        <KPICard 
          title="Save Conversion" 
          value={`${((metrics?.saveConversion?.value || 0) * 100).toFixed(1)}%`} 
          state={metrics?.saveConversion?.state}
          subtitle={`From ${metrics?.saveConversion?.sampleSize || 0} requested`}
          testId="kpi-save-conversion"
        />
        <KPICard 
          title="Recommendation Requests" 
          value={`${((metrics?.requestConversion?.value || 0) * 100).toFixed(1)}%`} 
          state={metrics?.requestConversion?.state}
          subtitle={`From ${metrics?.requestConversion?.sampleSize || 0} sessions`}
          testId="kpi-request-conversion"
        />
        <KPICard
          title="Booking Request Conversion"
          value={`${((metrics?.bookingRequestConversion?.value || 0) * 100).toFixed(1)}%`}
          state={metrics?.bookingRequestConversion?.state}
          subtitle={`From ${metrics?.bookingRequestConversion?.sampleSize || 0} sessions`}
          testId="kpi-booking-request-conversion"
        />
        <KPICard 
          title="Advisor Preview" 
          value={`${((metrics?.advisorConversion?.value || 0) * 100).toFixed(1)}%`} 
          state={metrics?.advisorConversion?.state}
          subtitle={`From ${metrics?.advisorConversion?.sampleSize || 0} sessions`}
          testId="kpi-advisor-preview"
        />
        <KPICard 
          title="P50 Latency" 
          value={`${metrics?.latencyMs?.p50 || 0}ms`} 
          subtitle="Median response time"
          testId="kpi-latency-p50"
        />
        <KPICard 
          title="P95 Latency" 
          value={`${metrics?.latencyMs?.p95 || 0}ms`} 
          subtitle="95th percentile response time"
          testId="kpi-latency-p95"
        />
      </div>

      {(funnelStages.length > 0 || sourceBreakdown.length > 0 || dailyTrend.length > 0) && (
        <MetricsCharts funnelData={funnelStages} sourceBreakdown={sourceBreakdown} dailyTrend={dailyTrend} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1 bg-card border-border/50 shadow-sm flex flex-col h-[500px]">
          <CardHeader className="border-b border-border/50 pb-4">
            <CardTitle className="text-lg">Failure Cohorts</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-y-auto flex-1">
            {isFailuresLoading ? (
              <div data-testid="status-failures-loading" className="p-6 text-center text-muted-foreground">Loading...</div>
            ) : failureCohorts.length > 0 ? (
              <Table data-testid="table-failure-cohorts">
                <TableHeader className="sticky top-0 bg-card z-10 shadow-sm">
                  <TableRow>
                    <TableHead>Event Type</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {failureCohorts.map((cohort: any) => (
                    <TableRow key={cohort.cohort}>
                      <TableCell className="font-medium text-sm capitalize">
                        {cohort.cohort?.replace(/-/g, ' ')}
                        {cohort.state === 'insufficient_sample' && (
                          <Badge variant="outline" className="ml-2 text-[10px]">Low Sample</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">{cohort.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="p-6 text-center text-muted-foreground">No failure cohorts found.</div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 bg-card border-border/50 shadow-sm flex flex-col h-[500px]">
          <CardHeader className="border-b border-border/50 pb-4 flex flex-col space-y-4">
            <div className="flex flex-row items-center justify-between">
              <CardTitle className="text-lg">Recent Conversations</CardTitle>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>Prev</Button>
                <div className="flex items-center text-sm text-muted-foreground px-2">Page {page + 1}</div>
                <Button variant="outline" size="sm" onClick={() => setPage(page + 1)} disabled={convoRows.length < limit}>Next</Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="relative w-48">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input 
                  data-testid="input-search-conversations"
                  placeholder="Search session ID..." 
                  className="pl-9 h-9 bg-background"
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(0); }}
                />
              </div>
              <Select value={sourceFilter} onValueChange={v => { setSourceFilter(v as AdminSourceParameter | 'all'); setPage(0); }}>
                <SelectTrigger className="w-[120px] h-9 bg-background"><SelectValue placeholder="Source" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  <SelectItem value="live">Live</SelectItem>
                  <SelectItem value="demo">Demo</SelectItem>
                </SelectContent>
              </Select>
              <Select value={outcomeFilter} onValueChange={v => { setOutcomeFilter(v); setPage(0); }}>
                <SelectTrigger className="w-[130px] h-9 bg-background"><SelectValue placeholder="Outcome" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Outcomes</SelectItem>
                  <SelectItem value="completion">Completion</SelectItem>
                  <SelectItem value="recommendation">Recommendations</SelectItem>
                  <SelectItem value="save">Saved</SelectItem>
                  <SelectItem value="advisor_preview">Advisor</SelectItem>
                </SelectContent>
              </Select>
              <Select value={failureFilter} onValueChange={v => { setFailureFilter(v as AdminConversationFailureClassParameter | 'all'); setPage(0); }}>
                <SelectTrigger className="w-[130px] h-9 bg-background"><SelectValue placeholder="Failures" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any/None</SelectItem>
                  <SelectItem value="fallback">Fallback</SelectItem>
                  <SelectItem value="unresolved_intent">Unresolved</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="p-0 overflow-y-auto flex-1">
            {isConversationsLoading ? (
              <div data-testid="status-conversations-loading" className="p-6 text-center text-muted-foreground">Loading...</div>
            ) : convoRows.length > 0 ? (
              <Table data-testid="table-conversations">
                <TableHeader className="sticky top-0 bg-card z-10 shadow-sm">
                  <TableRow>
                    <TableHead>Session ID</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Turns</TableHead>
                    <TableHead className="text-right">Fallbacks</TableHead>
                    <TableHead>Review</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {convoRows.map((row: any) => (
                    <TableRow key={row.sessionId} data-testid={`row-conversation-${row.sessionId}`} className="group cursor-pointer" onClick={() => setDrilldownId(row.sessionId)}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{row.sessionId}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="capitalize text-[10px]">{row.source}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize text-[10px]">{row.outcome}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize text-[10px]">{row.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right">{row.turnCount}</TableCell>
                      <TableCell className="text-right">
                        {row.fallbackCount > 0 ? (
                          <span className="text-destructive font-bold">{row.fallbackCount}</span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.latestReviewLabel ? (
                          <Badge className="bg-primary/20 text-primary border-primary/30 hover:bg-primary/30">
                            {row.latestReviewLabel}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground opacity-50">Unlabelled</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity">
                          View <ArrowRight size={14} className="ml-1" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="p-6 text-center text-muted-foreground">No conversations found.</div>
            )}
          </CardContent>
        </Card>
      </div>

      <ConversationDrilldown 
        sessionId={drilldownId} 
        open={!!drilldownId} 
        onOpenChange={(open) => !open && setDrilldownId(null)} 
      />
    </div>
  );
}
