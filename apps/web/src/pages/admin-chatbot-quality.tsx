import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LiveTelemetryTab } from '@/components/admin/live-telemetry-tab';
import { EvaluationsTab } from '@/components/admin/evaluations-tab';
import { ShieldAlert, Activity, CheckSquare } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function AdminChatbotQuality() {
  const [dateRange, setDateRange] = useState('7d');

  return (
    <div className="flex-1 p-4 md:p-8 max-w-7xl mx-auto w-full flex flex-col">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight flex items-center gap-3">
            <div className="p-2 bg-destructive/10 text-destructive rounded-lg">
              <ShieldAlert size={28} />
            </div>
            Quality Control
          </h1>
          <p className="text-muted-foreground mt-2 text-lg">
            Operational overview of assistant conversation health and evaluation datasets.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-muted-foreground">Timeframe:</span>
          <Select value={dateRange} onValueChange={setDateRange}>
            <SelectTrigger data-testid="select-date-range" className="w-[160px] bg-background">
              <SelectValue placeholder="Select timeframe" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="7d">Last 7 calendar days</SelectItem>
              <SelectItem value="30d">Last 30 calendar days</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs defaultValue="telemetry" className="flex-1 flex flex-col">
        <TabsList className="grid w-full max-w-md grid-cols-2 p-1 bg-muted/50 border border-border/50">
          <TabsTrigger value="telemetry" className="flex items-center gap-2">
            <Activity size={16} /> Live Telemetry
          </TabsTrigger>
          <TabsTrigger value="evaluations" className="flex items-center gap-2">
            <CheckSquare size={16} /> Model Evaluations
          </TabsTrigger>
        </TabsList>
        
        <TabsContent value="telemetry" className="flex-1">
          <LiveTelemetryTab dateRange={dateRange} />
        </TabsContent>
        
        <TabsContent value="evaluations" className="flex-1">
          <EvaluationsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
