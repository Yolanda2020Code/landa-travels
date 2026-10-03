import { useState, useMemo, useEffect } from 'react';
import { 
  useListAdminChatbotEvaluations, 
  useGetAdminChatbotEvaluation, 
  useGetAdminChatbotConfusionMatrix, 
  getExportAdminChatbotEvaluationUrl,
  getGetAdminChatbotConfusionMatrixQueryKey,
  getGetAdminChatbotEvaluationQueryKey
} from '@workspace/api-client-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Download, ChevronRight, CheckCircle2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

function ConfusionMatrixGrid({ matrixRows }: { matrixRows: { expected: string; predicted: string; count: number }[] }) {
  const allClasses = useMemo(() => Array.from(new Set([...matrixRows.map(r => r.expected), ...matrixRows.map(r => r.predicted)])).sort(), [matrixRows]);
  const [classFilter, setClassFilter] = useState('');

  const classes = useMemo(() => 
    classFilter ? allClasses.filter(c => c.toLowerCase().includes(classFilter.toLowerCase())) : allClasses,
  [allClasses, classFilter]);
  
  const getCount = (exp: string, pred: string) => {
    return matrixRows.find(r => r.expected === exp && r.predicted === pred)?.count || 0;
  };

  return (
    <div className="mb-8">
      <div className="flex justify-end mb-2">
        <input 
          placeholder="Filter classes..." 
          className="border border-border bg-background text-sm rounded px-2 py-1 w-48"
          value={classFilter}
          onChange={e => setClassFilter(e.target.value)}
        />
      </div>
      <div className="overflow-x-auto border rounded-md">
        <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[120px] bg-muted/30">Expected \ Predicted</TableHead>
            {classes.map(c => (
              <TableHead key={c} className="text-center font-mono text-[10px] min-w-[80px]" title={c}>
                <div className="writing-vertical-lr transform -rotate-180 h-24 mx-auto">{c}</div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {classes.map(exp => (
            <TableRow key={exp}>
              <TableCell className="font-mono text-[10px] font-semibold bg-muted/10 truncate max-w-[120px]" title={exp}>{exp}</TableCell>
              {classes.map(pred => {
                const count = getCount(exp, pred);
                const isCorrect = exp === pred;
                return (
                  <TableCell key={pred} className={`text-center ${count > 0 ? (isCorrect ? 'bg-primary/20 text-primary font-bold' : 'bg-destructive/20 text-destructive font-bold') : 'text-muted-foreground/30'}`}>
                    {count}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}

function calculateMetrics(rows: { expected: string; predicted: string; count: number }[]) {
  const classes = Array.from(new Set([...rows.map(r => r.expected), ...rows.map(r => r.predicted)]));
  const metrics = classes.map(cls => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const r of rows) {
      if (r.expected === cls && r.predicted === cls) tp += r.count;
      else if (r.expected === cls && r.predicted !== cls) fn += r.count;
      else if (r.expected !== cls && r.predicted === cls) fp += r.count;
      else tn += r.count;
    }
    const support = tp + fn;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
    return { class: cls, support, precision, recall, f1 };
  });

  return metrics.sort((a, b) => b.support - a.support);
}

export function EvaluationsTab() {
  const { data: evalsData, isLoading: isLoadingList } = useListAdminChatbotEvaluations();
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  const { data: matrixData, isLoading: isLoadingMatrix } = useGetAdminChatbotConfusionMatrix(
    selectedRunId!,
    { query: { enabled: !!selectedRunId, queryKey: getGetAdminChatbotConfusionMatrixQueryKey(selectedRunId!) } }
  );

  const { data: evalDetail, isLoading: isLoadingDetail } = useGetAdminChatbotEvaluation(
    selectedRunId!,
    { query: { enabled: !!selectedRunId, queryKey: getGetAdminChatbotEvaluationQueryKey(selectedRunId!) } }
  );

  const runs = (evalsData as any)?.rows || [];
  const matrixRows = (matrixData as any)?.rows || [];
  const metrics = useMemo(() => calculateMetrics(matrixRows), [matrixRows]);
  
  useEffect(() => {
    if (runs.length > 0 && selectedRunId === null) {
      setSelectedRunId(runs[0].id);
    }
  }, [runs, selectedRunId]);

  if (isLoadingList) return <div data-testid="status-loading" className="p-8 text-center text-muted-foreground animate-pulse">Loading evaluations...</div>;

  if (runs.length === 0) {
    return (
      <div data-testid="status-empty" className="flex items-center justify-center p-12 bg-card border border-border/50 rounded-xl mt-6">
        <p className="text-muted-foreground">No evaluation runs available.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
      <div className="lg:col-span-1 border border-border/50 bg-card rounded-xl shadow-sm overflow-hidden flex flex-col h-[800px]">
        <div className="p-4 border-b border-border/50 bg-muted/20">
          <h3 className="font-bold text-sm uppercase tracking-wider text-muted-foreground">Evaluation Provenance</h3>
        </div>
        <div className="overflow-y-auto flex-1 p-2 space-y-1">
          {runs.map((run: any) => (
            <button
              key={run.id}
              data-testid={`button-eval-run-${run.id}`}
              onClick={() => setSelectedRunId(run.id)}
              className={`w-full text-left p-3 rounded-lg flex items-center justify-between transition-colors ${
                selectedRunId === run.id ? 'bg-primary/10 border-primary/30 border' : 'hover:bg-muted border border-transparent'
              }`}
            >
              <div>
                <div className="font-medium text-sm flex items-center gap-2">
                  <span className="truncate max-w-[120px]">{run.runKey || `Run #${run.id}`}</span>
                  <Badge variant={selectedRunId === run.id ? "default" : "secondary"} className="text-[10px] px-1.5 h-4 ml-auto">
                    {run.metricSummary?.accuracy !== undefined ? `${(run.metricSummary.accuracy * 100).toFixed(1)}%` : 'N/A'}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-2 grid grid-cols-2 gap-1">
                  <div><span className="font-semibold">Model:</span> <span className="truncate inline-block align-bottom max-w-[80px]" title={run.modelVersion}>{run.modelVersion || 'unknown'}</span></div>
                  <div><span className="font-semibold">Data:</span> <span className="truncate inline-block align-bottom max-w-[80px]" title={run.datasetVersion}>{run.datasetVersion || 'unknown'}</span></div>
                  <div className="col-span-2 text-[10px] mt-1 opacity-70">
                    {new Date(run.createdAt).toLocaleString()}
                  </div>
                </div>
              </div>
              <ChevronRight size={16} className={`shrink-0 ml-2 ${selectedRunId === run.id ? "text-primary" : "text-muted-foreground"}`} />
            </button>
          ))}
        </div>
      </div>

      <div className="lg:col-span-2 flex flex-col gap-6">
        {selectedRunId ? (
          <>
            <Card className="bg-card border-border/50 shadow-sm">
              <CardHeader className="flex flex-row items-start justify-between pb-4">
                <div>
                  <CardTitle className="text-xl">Confusion Matrix & Metrics</CardTitle>
                  <CardDescription>Performance metrics across intent classes.</CardDescription>
                </div>
                <a href={getExportAdminChatbotEvaluationUrl(selectedRunId, { format: 'csv' })} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-2" data-testid="link-export-csv">
                    <Download size={14} /> Export CSV
                  </Button>
                </a>
              </CardHeader>
              <CardContent>
                {isLoadingMatrix ? (
                  <div data-testid="status-loading-matrix" className="py-8 text-center text-muted-foreground">Calculating metrics...</div>
                ) : matrixRows.length > 0 ? (
                  <>
                    <ConfusionMatrixGrid matrixRows={matrixRows} />
                    <div className="overflow-x-auto">
                      <Table data-testid="table-metrics">
                        <TableHeader>
                        <TableRow>
                          <TableHead className="font-semibold text-foreground">Class</TableHead>
                          <TableHead className="text-right">Support</TableHead>
                          <TableHead className="text-right">Precision</TableHead>
                          <TableHead className="text-right">Recall</TableHead>
                          <TableHead className="text-right">F1 Score</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {metrics.map(m => (
                          <TableRow key={m.class}>
                            <TableCell className="font-medium">{m.class}</TableCell>
                            <TableCell className="text-right text-muted-foreground">{m.support}</TableCell>
                            <TableCell className="text-right">{(m.precision * 100).toFixed(1)}%</TableCell>
                            <TableCell className="text-right">{(m.recall * 100).toFixed(1)}%</TableCell>
                            <TableCell className="text-right font-semibold">{(m.f1 * 100).toFixed(1)}%</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  </>
                ) : (
                  <div className="py-8 text-center text-muted-foreground">No matrix data available.</div>
                )}
              </CardContent>
            </Card>

            <Card className="bg-card border-border/50 shadow-sm flex-1">
              <CardHeader className="pb-4">
                <CardTitle className="text-xl">Evaluation Run Details</CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0 flex flex-col gap-4">
                {isLoadingDetail ? (
                  <div data-testid="status-loading-samples" className="p-8 text-center text-muted-foreground">Loading samples...</div>
                ) : evalDetail ? (
                  <>
                    <div className="bg-muted p-4 rounded-lg text-sm grid grid-cols-2 gap-4">
                      <div>
                        <span className="font-semibold block mb-1">Command</span>
                        <code className="bg-background px-2 py-1 rounded text-[10px] break-all">
                          {(evalDetail as any).run?.command || 'N/A'}
                        </code>
                      </div>
                      <div>
                        <span className="font-semibold block mb-1">Confidence</span>
                        <div className="text-xs">
                          Mean: {(evalDetail as any).metricSummary?.confidence?.mean == null
                            ? 'Not available'
                            : `${((evalDetail as any).metricSummary.confidence.mean * 100).toFixed(1)}%`} <br/>
                          Samples: {(evalDetail as any).metricSummary?.confidence?.count}
                        </div>
                      </div>
                    </div>

                    <h4 className="font-bold text-sm mt-2">Prediction Samples</h4>
                    {(evalDetail as any)?.predictions?.length > 0 ? (
                      <div className="h-[400px] overflow-y-auto border rounded-md">
                        <Table data-testid="table-eval-predictions">
                          <TableHeader className="sticky top-0 bg-card z-10 shadow-sm">
                            <TableRow>
                              <TableHead>Sample</TableHead>
                              <TableHead>Expected</TableHead>
                              <TableHead>Predicted</TableHead>
                              <TableHead className="text-right">Result</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {((evalDetail as any).predictions || []).map((p: any) => (
                              <TableRow key={p.id}>
                                <TableCell className="font-mono text-xs text-muted-foreground max-w-[200px] truncate" title={p.sampleKey}>
                                  {p.sampleKey}
                                </TableCell>
                                <TableCell className="text-xs">{p.expected}</TableCell>
                                <TableCell className="text-xs">{p.predicted}</TableCell>
                                <TableCell className="text-right">
                                  {p.expected === p.predicted ? (
                                    <CheckCircle2 size={16} className="text-green-500 inline-block" />
                                  ) : (
                                    <XCircle size={16} className="text-red-500 inline-block" />
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <div className="p-8 text-center text-muted-foreground">No predictions recorded.</div>
                    )}
                  </>
                ) : null}
              </CardContent>
            </Card>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center border border-border/50 bg-card rounded-xl text-muted-foreground">
            Select an evaluation run to view its metrics and confusion matrix.
          </div>
        )}
      </div>
    </div>
  );
}
