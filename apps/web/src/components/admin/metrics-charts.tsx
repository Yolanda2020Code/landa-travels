import { useMemo } from 'react';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Bar, BarChart, XAxis, YAxis, ResponsiveContainer, Cell, PieChart, Pie, AreaChart, Area, CartesianGrid } from 'recharts';

export function MetricsCharts({ funnelData, sourceBreakdown, dailyTrend }: { funnelData: any[], sourceBreakdown: any[], dailyTrend?: any[] }) {
  const chartConfig = {
    count: { label: "Count", color: "hsl(var(--primary))" }
  };

  const pieConfig = sourceBreakdown.reduce((acc, curr, i) => {
    acc[curr.source] = { label: curr.source, color: `hsl(var(--chart-${(i % 5) + 1}))` };
    return acc;
  }, {} as any);

  const pieData = sourceBreakdown.map((item) => ({
    name: item.source,
    value: item.sessions,
    fill: pieConfig[item.source]?.color
  }));

  const trendConfig = {
    sessions: { label: "Sessions", color: "hsl(var(--primary))" },
    completions: { label: "Completions", color: "hsl(var(--chart-2))" },
    fallbacks: { label: "Fallbacks", color: "hsl(var(--destructive))" },
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
      <div className="bg-card border border-border/50 rounded-xl p-6 shadow-sm">
        <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">Traffic Sources</h3>
        <ChartContainer config={pieConfig} className="h-64">
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent />} />
            <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={2} />
          </PieChart>
        </ChartContainer>
      </div>

      <div className="bg-card border border-border/50 rounded-xl p-6 shadow-sm lg:col-span-2">
        <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">Daily Trend</h3>
        {dailyTrend && dailyTrend.length > 0 ? (
          <ChartContainer config={trendConfig} className="h-64 w-full">
            <AreaChart data={dailyTrend} margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="fillSessions" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-sessions)" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="var(--color-sessions)" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="fillCompletions" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-completions)" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="var(--color-completions)" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" axisLine={false} tickLine={false} tickMargin={8} minTickGap={32} />
              <YAxis axisLine={false} tickLine={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area type="monotone" dataKey="sessions" stroke="var(--color-sessions)" fill="url(#fillSessions)" />
              <Area type="monotone" dataKey="completions" stroke="var(--color-completions)" fill="url(#fillCompletions)" />
              <Area type="monotone" dataKey="fallbacks" stroke="var(--color-fallbacks)" fill="none" strokeWidth={2} />
            </AreaChart>
          </ChartContainer>
        ) : (
          <div className="h-64 flex items-center justify-center text-muted-foreground">No trend data available</div>
        )}
      </div>

      <div className="bg-card border border-border/50 rounded-xl p-6 shadow-sm lg:col-span-3">
        <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">Named Slot Drop-off Funnel</h3>
        <ChartContainer config={chartConfig} className="h-64 w-full">
          <BarChart data={funnelData} layout="vertical" margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
            <XAxis type="number" hide />
            <YAxis dataKey="slot" type="category" width={120} tickLine={false} axisLine={false} fontSize={12} className="capitalize" />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="sessions" fill="var(--color-count)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartContainer>
      </div>
    </div>
  );
}
