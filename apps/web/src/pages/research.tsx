import React, { useState } from "react";
import {
  BookOpen,
  AlertTriangle,
  ExternalLink,
  Plane,
  Train,
  CarFront,
  Bus,
  Info,
  Users,
  Route,
  Activity,
  ArrowRight
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const GHG_FACTORS = [
  { id: "domestic-flight", label: "Domestic Flight", factor: 0.22928, unit: "passenger-km", icon: Plane, note: "Includes radiative forcing uplift", color: "hsl(0 80% 60%)" },
  { id: "short-flight", label: "Short-haul Flight", factor: 0.12786, unit: "passenger-km", icon: Plane, note: "Typical European route", color: "hsl(20 80% 60%)" },
  { id: "medium-car", label: "Medium Car", factor: 0.17209, unit: "vehicle-km", icon: CarFront, note: "Emissions split across passengers", color: "hsl(40 80% 60%)" },
  { id: "coach", label: "Coach (Bus)", factor: 0.03948, unit: "passenger-km", icon: Bus, note: "High occupancy average", color: "hsl(140 60% 50%)" },
  { id: "national-rail", label: "National Rail", factor: 0.03092, unit: "passenger-km", icon: Train, note: "Mixed electric & diesel network", color: "hsl(170 70% 50%)" },
  { id: "intl-rail", label: "International Rail", factor: 0.01135, unit: "passenger-km", icon: Train, note: "High-speed electric (e.g. Eurostar)", color: "hsl(190 90% 50%)" }
];

const PAPERS = [
  {
    title: "The carbon footprint of global tourism",
    authors: "Lenzen et al.",
    journal: "Nature Climate Change 8 (2018)",
    url: "https://www.nature.com/articles/s41558-018-0141-x",
    summary: "A comprehensive global multi-region input-output footprint analysis. It maps the supply chains of travel to show that tourism is responsible for a significantly larger share of global greenhouse gas emissions than previously estimated.",
    limitations: "Relies on a 2013 baseline and economy-wide averages, making it excellent for global accounting but not a precise individual trip calculator."
  },
  {
    title: "The contribution of global aviation to anthropogenic climate forcing for 2000 to 2018",
    authors: "Lee et al.",
    journal: "Atmospheric Environment 244 (2021)",
    url: "https://doi.org/10.1016/j.atmosenv.2020.117834",
    summary: "Explains and quantifies that aviation warming includes non-CO2 effects (like contrails and nitrogen oxides). These effects make aviation's historical climate impact roughly three times that of its CO2 emissions alone.",
    limitations: "A global attribution study that cannot precisely predict the non-CO2 radiative forcing for any single specific flight due to variable weather."
  },
  {
    title: "Drivers of global tourism carbon emissions",
    authors: "Sun et al.",
    journal: "Nature Communications 15 (2024)",
    url: "https://www.nature.com/articles/s41467-024-54582-7",
    summary: "Provides an updated look at the structural drivers behind tourism emissions, focusing on how tourism demand growth consistently outpaces decarbonization and efficiency improvements in the sector.",
    limitations: "National and sector-level modelling smooths out local variation, meaning local grassroots sustainability efforts aren't always visible in macro data."
  }
];

export default function Research() {
  const [distance, setDistance] = useState<number>(500);
  const [travellers, setTravellers] = useState<number>(2);
  const [selectedMode, setSelectedMode] = useState<string>("short-flight");
  const [view, setView] = useState<"per-person" | "total">("per-person");

  const results = GHG_FACTORS.map(mode => {
    let totalCO2, perPersonCO2;
    if (mode.unit === "vehicle-km") {
      totalCO2 = distance * mode.factor;
      perPersonCO2 = totalCO2 / travellers;
    } else {
      perPersonCO2 = distance * mode.factor;
      totalCO2 = perPersonCO2 * travellers;
    }
    return { ...mode, totalCO2, perPersonCO2 };
  }).sort((a, b) => {
    const valA = view === "total" ? a.totalCO2 : a.perPersonCO2;
    const valB = view === "total" ? b.totalCO2 : b.perPersonCO2;
    return valB - valA;
  });

  const maxVal = Math.max(...results.map(r => view === "total" ? r.totalCO2 : r.perPersonCO2));

  const avoidedTonnes = (10000 * distance * (0.12786 - 0.03092)) / 1000;
  const uncertaintyRange = avoidedTonnes * 0.25;
  const lowerBound = avoidedTonnes - uncertaintyRange;
  const upperBound = avoidedTonnes + uncertaintyRange;

  return (
    <div className="flex flex-col w-full min-h-[100dvh] bg-background text-foreground selection:bg-primary/30 font-sans motion-reduce:transition-none">
      {/* Decorative background noise */}
      <div className="noise-overlay" aria-hidden="true" />

      {/* Hero Section */}
      <section className="relative pt-32 pb-20 overflow-hidden border-b border-border/40">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-transparent pointer-events-none" />
        <div className="container px-4 md:px-6 max-w-5xl mx-auto relative z-10">
          <Badge variant="outline" className="mb-8 font-mono tracking-widest text-primary border-primary/20 bg-primary/10 py-1.5 px-3">
            EVIDENCE-LED TRAVEL
          </Badge>
          <h1 className="text-5xl md:text-7xl font-serif font-bold mb-8 leading-[1.1] tracking-tight">
            Climate Trade-offs, <br/><span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-cyan-300">Visualised.</span>
          </h1>
          <p className="text-xl md:text-2xl text-muted-foreground leading-relaxed max-w-3xl">
            We believe in honest carbon accounting, free from greenwashing. Explore the real impact of your travel choices using verified scientific data. Understand CO2e through interaction, not dense prose.
          </p>
        </div>
      </section>

      {/* Interactive Climate Exhibit */}
      <section className="py-24 relative">
        <div className="container px-4 md:px-6 max-w-6xl mx-auto">
          <div className="mb-16 flex flex-col md:flex-row md:items-end justify-between gap-6">
            <div>
              <h2 className="text-3xl md:text-4xl font-serif font-bold mb-4 flex items-center gap-3">
                <Activity className="text-primary" size={32} /> The Carbon Calculator
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl">
                Adjust the scenario below to see how distance, group size, and transport mode dramatically alter your climate footprint.
              </p>
            </div>
            <div className="bg-card border border-border rounded-xl p-1 inline-flex">
              <Tabs value={view} onValueChange={(v) => { if (v === "per-person" || v === "total") setView(v); }} className="w-full">
                <TabsList className="grid w-full grid-cols-2 w-[240px]">
                  <TabsTrigger value="per-person" className="text-sm font-medium">Per Person</TabsTrigger>
                  <TabsTrigger value="total" className="text-sm font-medium">Trip Total</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>

          <div className="grid lg:grid-cols-12 gap-12 lg:gap-8 items-start">
            {/* Controls Panel */}
            <div className="lg:col-span-4 space-y-8 glass-panel p-6 md:p-8 rounded-2xl relative z-10">
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <Label htmlFor="distance" className="text-base font-medium flex items-center gap-2">
                    <Route size={18} className="text-primary" /> Journey Distance
                  </Label>
                  <span className="font-mono text-primary font-bold bg-primary/10 px-2 py-1 rounded-md">{distance} km</span>
                </div>
                <Slider
                  id="distance"
                  min={50}
                  max={3000}
                  step={50}
                  value={[distance]}
                  onValueChange={(v) => setDistance(v[0])}
                  className="py-4"
                  aria-label="Journey distance in kilometers"
                />
                <div className="flex justify-between text-xs text-muted-foreground font-mono">
                  <span>50 km</span>
                  <span>3000 km</span>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <Label htmlFor="travellers" className="text-base font-medium flex items-center gap-2">
                    <Users size={18} className="text-primary" /> Travellers
                  </Label>
                  <span className="font-mono text-primary font-bold bg-primary/10 px-2 py-1 rounded-md">{travellers}</span>
                </div>
                <Slider
                  id="travellers"
                  min={1}
                  max={6}
                  step={1}
                  value={[travellers]}
                  onValueChange={(v) => setTravellers(v[0])}
                  className="py-4"
                  aria-label="Number of travellers"
                />
                <div className="flex justify-between text-xs text-muted-foreground font-mono">
                  <span>Solo</span>
                  <span>Group of 6</span>
                </div>
              </div>

              <div className="pt-4 border-t border-border/50">
                <Label className="text-base font-medium mb-4 block">Select Primary Mode</Label>
                <RadioGroup value={selectedMode} onValueChange={setSelectedMode} className="grid grid-cols-2 gap-3" aria-label="Transport mode">
                  {GHG_FACTORS.map(mode => {
                    const Icon = mode.icon;
                    return (
                      <Label
                        key={mode.id}
                        htmlFor={`mode-${mode.id}`}
                        className={`cursor-pointer flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all hover:bg-secondary/50 focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 focus-within:ring-offset-background ${selectedMode === mode.id ? 'border-primary bg-primary/10 text-primary shadow-[0_0_15px_rgba(0,190,255,0.15)]' : 'border-border bg-card/50 text-muted-foreground'}`}
                      >
                        <RadioGroupItem value={mode.id} id={`mode-${mode.id}`} className="sr-only" />
                        <Icon size={24} className="mb-2" />
                        <span className="text-xs font-bold text-center leading-tight">{mode.label}</span>
                      </Label>
                    )
                  })}
                </RadioGroup>
              </div>
            </div>

            {/* Visualization */}
            <div className="lg:col-span-8 flex flex-col justify-center min-h-[500px]">
              <div className="space-y-6">
                {results.map((mode) => {
                  const val = view === "total" ? mode.totalCO2 : mode.perPersonCO2;
                  const isSelected = mode.id === selectedMode;
                  const widthPct = maxVal === 0 ? 0 : Math.max((val / maxVal) * 100, 2);
                  const Icon = mode.icon;

                  return (
                    <div
                      key={mode.id}
                      className={`relative flex flex-col p-4 rounded-xl border transition-all duration-300 ${isSelected ? 'border-primary/50 bg-primary/5 shadow-sm' : 'border-transparent hover:border-border/50'}`}
                      role="region"
                      aria-label={`${mode.label} comparison`}
                    >
                      <div className="flex items-end justify-between mb-3 z-10 relative">
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-lg ${isSelected ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground'}`}>
                            <Icon size={20} />
                          </div>
                          <div>
                            <h3 className={`font-bold flex items-center gap-2 ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                              {mode.label}
                              {isSelected && <Badge variant="secondary" className="text-[10px] uppercase tracking-wider py-0 px-1.5 h-5 bg-primary/20 text-primary">Selected</Badge>}
                            </h3>
                            <p className="text-xs text-muted-foreground">{mode.note}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-2xl font-mono font-bold tracking-tight">
                            {val.toFixed(1)} <span className="text-sm font-sans text-muted-foreground font-normal">kg CO₂e</span>
                          </div>
                        </div>
                      </div>

                      <div className="h-8 w-full bg-secondary/40 rounded-md overflow-hidden relative" aria-hidden="true">
                        <div
                          className="absolute top-0 left-0 h-full rounded-md transition-all duration-700 ease-out flex items-center justify-end pr-2 overflow-hidden motion-reduce:transition-none motion-reduce:duration-0"
                          style={{
                            width: `${widthPct}%`,
                            backgroundColor: isSelected ? 'hsl(var(--primary))' : mode.color,
                            opacity: isSelected ? 1 : 0.7,
                            backgroundImage: isSelected ? 'repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(0,0,0,0.1) 10px, rgba(0,0,0,0.1) 20px)' : 'none'
                          }}
                        >
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Data Source Callout */}
              <div className="mt-12 p-6 rounded-xl border border-border/60 bg-card/30 text-sm text-muted-foreground flex gap-4">
                <Info className="text-primary shrink-0 mt-0.5" size={20} />
                <div className="space-y-3">
                  <p>
                    <strong className="text-foreground">Illustrative cross-mode benchmark based on 2026 UK Government GHG Conversion Factors</strong> (published 11 June 2026). Factors shown are kg CO₂e per passenger-km (or vehicle-km for cars). They provide a consistent comparison series, not Germany-specific results.
                  </p>
                  <p>
                    <strong>Germany context:</strong> Actual results for journeys from Germany vary with the route, operator, occupancy, electricity mix, aircraft, and aviation non-CO₂ treatment. The planner labels route-specific Climatiq results separately when the live service is available.
                  </p>
                  <p>
                    <strong>Assumptions & Uncertainty:</strong> These calculations are estimates intended to illustrate structural differences between transport modes. They do not represent exact routing, real-time load factors, or weather-induced variations.
                  </p>
                  <p className="flex flex-wrap gap-4 mt-2">
                    <a href="https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                      2026 UK Gov Factors <ExternalLink size={12} />
                    </a>
                    <a href="https://assets.publishing.service.gov.uk/media/6a2940543b15d05a7ce3202e/2026-GHG-conversion-factors-methodology-report.pdf" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                      Methodology Report (PDF) <ExternalLink size={12} />
                    </a>
                    <a href="https://www.icao.int/environmental-protection/environmental-tools/icec" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                      ICAO Methodology <ExternalLink size={12} />
                    </a>
                    <a href="https://www.umweltbundesamt.de/themen/verkehr/emissionsdaten" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                      German Environment Agency data <ExternalLink size={12} />
                    </a>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Illustrative Systemic Projection */}
      <section className="py-24 relative border-t border-border/40 bg-card/5">
        <div className="container px-4 md:px-6 max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row gap-12 items-center">
            <div className="flex-1 space-y-6">
              <Badge variant="outline" className="font-mono tracking-widest text-primary border-primary/20 bg-primary/10">SYSTEMIC IMPACT</Badge>
              <h2 className="text-3xl md:text-4xl font-serif font-bold">Scaling the Shift</h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Individual choices matter most when scaled. If 10,000 annual single-traveller trips of your selected <strong className="text-foreground font-mono bg-secondary/50 px-1 py-0.5 rounded">{distance} km</strong> distance shifted from short-haul flights to national rail, the collective reduction in greenhouse gas emissions would be substantial.
              </p>
              <div className="p-4 rounded-xl border border-border/60 bg-card/30 text-sm text-muted-foreground space-y-2">
                <p><strong>Assumptions & Caveats:</strong> Based on 11 June 2026 UK Government conversion factors as a consistent illustrative benchmark, not German route averages. This is a mathematical scenario, not a forecast, business pledge, or live market result. It includes a ±25% illustrative range to show real-world variability.</p>
              </div>
            </div>

            <div className="flex-1 w-full relative">
              <div className="glass-panel p-8 rounded-2xl border border-primary/20 shadow-[0_0_40px_rgba(0,190,255,0.05)] relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 blur-[50px] rounded-full pointer-events-none" aria-hidden="true" />
                <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-6">Estimated CO₂e Avoided</h3>
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-6xl md:text-7xl font-serif font-bold tracking-tighter text-foreground">
                    {avoidedTonnes.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                  <span className="text-xl text-muted-foreground font-medium">tonnes</span>
                </div>

                <div className="mt-8 space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Illustrative Range (±25%)</span>
                    <span className="font-mono font-medium">{lowerBound.toLocaleString(undefined, { maximumFractionDigits: 0 })} – {upperBound.toLocaleString(undefined, { maximumFractionDigits: 0 })} t</span>
                  </div>
                  <div className="h-2 w-full bg-secondary rounded-full overflow-hidden flex relative" aria-hidden="true">
                    <div className="absolute left-[37.5%] right-[37.5%] h-full bg-primary/40 border-x-2 border-primary"></div>
                    <div className="absolute left-[50%] top-0 bottom-0 w-[2px] bg-foreground"></div>
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground mt-1">
                    <span>Lower bound</span>
                    <span>Expected</span>
                    <span>Upper bound</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* UN Tourism Educational Resource */}
      <section className="py-24 bg-card/40 border-y border-border/40 relative">
        <div className="container px-4 md:px-6 max-w-5xl mx-auto">
          <Badge variant="outline" className="mb-6">Global Perspective</Badge>
          <h2 className="text-3xl md:text-4xl font-serif font-bold mb-12">The Systemic Challenge</h2>

          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div className="aspect-video rounded-xl overflow-hidden border border-border shadow-2xl glass-panel relative group">
              <div className="absolute top-4 left-4 z-20 pointer-events-none">
                <Badge variant="secondary" className="bg-background/90 backdrop-blur text-xs font-medium border-border shadow-sm">
                  External source · UN Tourism
                </Badge>
              </div>
              <div className="absolute inset-0 bg-primary/10 group-hover:bg-transparent transition-colors pointer-events-none z-10"></div>
              <iframe
                src="https://www.youtube.com/embed/j5QkqzQXIfQ"
                title="Towards low carbon and climate resilient tourism (Session 1)"
                className="absolute inset-0 w-full h-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              ></iframe>
            </div>
            <div className="space-y-6">
              <h3 className="text-2xl font-bold">Towards low carbon and climate resilient tourism</h3>
              <p className="text-muted-foreground text-lg leading-relaxed">
                This official session by UN Tourism unpacks the intersection of global travel and climate adaptation. It highlights the urgent need for structural decarbonization across the sector, moving beyond superficial offsets to genuine emissions reduction.
              </p>

              <div className="p-5 rounded-xl border border-primary/20 bg-primary/5 space-y-3">
                <h4 className="font-bold text-foreground">Key Learning Points:</h4>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex gap-2"><ArrowRight size={16} className="text-primary shrink-0 mt-0.5" /> Tourism is highly vulnerable to climate change while simultaneously contributing to it.</li>
                  <li className="flex gap-2"><ArrowRight size={16} className="text-primary shrink-0 mt-0.5" /> Sector-wide transformation requires verifiable data and cross-border cooperation.</li>
                  <li className="flex gap-2"><ArrowRight size={16} className="text-primary shrink-0 mt-0.5" /> Empowering travellers with transparent emissions data is a critical step in shifting demand.</li>
                </ul>
              </div>

              <a href="https://www.unwto.org/sustainable-development/climate-action" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-primary hover:text-primary-foreground hover:bg-primary px-6 py-3 rounded-full border border-primary transition-all font-bold group">
                Explore UN Tourism Climate Action
                <ExternalLink size={18} className="group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
              </a>
              <p className="text-xs text-muted-foreground mt-4">
                Note: Landa Travels provides this resource for educational purposes and claims no endorsement from or affiliation with the UN.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Peer-Reviewed Foundations */}
      <section className="py-24">
        <div className="container px-4 md:px-6 max-w-6xl mx-auto">
          <div className="mb-16 md:text-center max-w-3xl mx-auto">
            <h2 className="text-3xl md:text-4xl font-serif font-bold mb-6 flex items-center md:justify-center gap-3">
              <BookOpen className="text-primary" size={32} /> Peer-Reviewed Foundations
            </h2>
            <p className="text-lg text-muted-foreground">
              These peer-reviewed papers provide crucial context for our product decisions and how we interpret tourism's massive, structural climate impact. Landa's internal trip estimation models are illustrative and not individually peer-reviewed.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {PAPERS.map((paper, i) => (
              <Card key={i} className="flex flex-col h-full bg-card/30 backdrop-blur-sm hover:border-primary/50 transition-colors shadow-none border-border/60 group">
                <CardHeader>
                  <div className="text-xs text-primary font-mono mb-3 uppercase tracking-wider">{paper.journal}</div>
                  <CardTitle className="text-xl leading-snug group-hover:text-primary transition-colors">{paper.title}</CardTitle>
                  <CardDescription className="font-medium text-foreground/80 mt-2">{paper.authors}</CardDescription>
                </CardHeader>
                <CardContent className="flex-grow space-y-6 text-sm text-muted-foreground">
                  <div>
                    <h5 className="font-bold text-foreground mb-1 uppercase tracking-wider text-xs">Plain-Language Summary</h5>
                    <p className="leading-relaxed">{paper.summary}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-destructive/5 border border-destructive/10 text-destructive/90">
                    <h5 className="font-bold mb-1 flex items-center gap-2 uppercase tracking-wider text-xs">
                      <AlertTriangle size={14} /> Limitations
                    </h5>
                    <p className="leading-relaxed text-xs">{paper.limitations}</p>
                  </div>
                </CardContent>
                <CardFooter className="pt-6 border-t border-border/40 mt-auto">
                  <a
                    href={paper.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-primary hover:underline font-bold w-full justify-between"
                  >
                    Read full publication <ExternalLink size={16} />
                  </a>
                </CardFooter>
              </Card>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}