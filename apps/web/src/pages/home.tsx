import { Link } from "wouter";
import { ArrowRight, Leaf, Globe, ShieldCheck, HeartHandshake, Map } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import heroImage from "@assets/generated_images/hero.jpg";
import missionImage from "@assets/generated_images/mission.jpg";

export default function Home() {
  return (
    <div className="flex flex-col w-full">
      {/* Hero Section */}
      <section className="relative min-h-[90dvh] flex items-center justify-center overflow-hidden">
        {/* Background Image */}
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: `url("${heroImage}")` }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-background/80 to-background" />

        <div className="container relative z-10 px-4 md:px-6 text-center max-w-5xl mx-auto flex flex-col items-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary mb-8 animate-fade-in-up shadow-[0_0_20px_rgba(0,240,255,0.1)]">
            <Leaf size={14} />
            <span className="text-xs font-bold tracking-widest uppercase">The Future of Travel</span>
          </div>

          <h1 className="text-5xl md:text-7xl lg:text-8xl font-serif font-bold text-foreground leading-[1.1] tracking-tight mb-6 animate-fade-in-up" style={{animationDelay: '0.1s'}}>
            See the world.<br className="hidden md:block" />
            <span className="text-primary italic">Leave no scar.</span>
          </h1>

          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed animate-fade-in-up" style={{animationDelay: '0.2s'}}>
            Landa Travels brings you the polish of premium booking paired with absolute transparency on climate and community impact. Journey with confidence and purpose.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 animate-fade-in-up w-full sm:w-auto" style={{animationDelay: '0.3s'}}>
            <Link href="/planner" className="w-full sm:w-auto">
              <Button size="lg" className="w-full rounded-full h-14 px-8 text-base font-semibold shadow-[0_0_30px_rgba(0,240,255,0.2)] hover:shadow-[0_0_40px_rgba(0,240,255,0.4)] transition-all">
                Start planning — no sign-in <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            </Link>
            <Link href="/about" className="w-full sm:w-auto">
              <Button size="lg" variant="outline" className="w-full rounded-full h-14 px-8 text-base font-semibold border-primary/20 hover:bg-primary/5 bg-background/50 backdrop-blur-sm">
                Our Mission
              </Button>
            </Link>
          </div>
          <p className="mt-4 max-w-xl text-sm text-muted-foreground">Explore and build a plan first. Sign in only when you want to save it, resume later, or request a demo booking.</p>
        </div>
      </section>

      {/* Philosophy Section */}
      <section className="py-24 md:py-32 bg-background relative border-t border-border/40">
        <div className="absolute top-0 right-0 w-1/3 h-1/2 bg-primary/5 rounded-full blur-[100px] pointer-events-none" />
        <div className="container mx-auto px-4 md:px-6 max-w-6xl">
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div className="space-y-6">
              <h2 className="text-3xl md:text-5xl font-serif font-bold leading-tight">
                Not just another booking engine.
              </h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Most platforms optimize for price or speed. We help you compare trade-offs using published climate guidance and clearly labelled demonstration estimates. Recommendations support informed decisions; they do not make travel impact-free.
              </p>
              <ul className="space-y-4 pt-4">
                {[
                  { icon: Globe, title: "Transparent Estimates", desc: "Illustrative carbon comparisons explain their source and limitations instead of presenting false precision." },
                  { icon: ShieldCheck, title: "Evidence Before Claims", desc: "Demo stays and experiences are labelled clearly until partner evidence can be independently checked." },
                  { icon: HeartHandshake, title: "Advisor Preview", desc: "See how privacy-minimised trip context could be prepared for a future human-advisor service." }
                ].map((item, i) => (
                  <li key={i} className="flex gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
                      <item.icon size={24} />
                    </div>
                    <div>
                      <h3 className="font-bold text-foreground text-lg mb-1">{item.title}</h3>
                      <p className="text-muted-foreground text-sm leading-relaxed">{item.desc}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative">
              <div className="aspect-[4/5] rounded-3xl overflow-hidden glass-panel p-2">
                <div
                  className="w-full h-full rounded-2xl bg-cover bg-center"
                  style={{ backgroundImage: `url("${missionImage}")` }}
                />
              </div>
              <div className="absolute -bottom-6 -left-6 glass-panel rounded-2xl p-6 w-64 shadow-2xl animate-fade-in-up" style={{animationDelay: '0.4s'}}>
                <div className="flex items-center gap-3 mb-3">
                  <Leaf className="text-primary" size={24} />
                  <span className="font-serif font-bold text-lg">Impact Focus</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  The demonstration explains how future recommendations could be considered alongside SDGs 11, 12 and 13 without claiming direct UN endorsement.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Flow Section */}
      <section className="py-24 bg-card border-y border-border/40">
        <div className="container mx-auto px-4 md:px-6 max-w-6xl text-center">
          <h2 className="text-3xl md:text-5xl font-serif font-bold mb-6">How Landa Works</h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-16">
            A conversational demonstration that gathers your preferences and explains the limits of its illustrative comparison data.
          </p>
          
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                step: "01",
                title: "Chat & Discover",
                desc: "Tell the planner your preferences. It builds context and compares a clearly labelled demonstration catalogue.",
                icon: Map
              },
              {
                step: "02",
                title: "Evaluate Options",
                desc: "Review clear, color-coded impact scores alongside pricing, allowing you to make informed trade-offs.",
                icon: ShieldCheck
              },
              {
                step: "03",
                title: "Save & Request",
                desc: "Save an itinerary, create a clearly labelled demo booking request, or preview a privacy-minimised advisor workspace.",
                icon: HeartHandshake
              }
            ].map((s, i) => (
              <Card key={i} className="bg-background border-border/50 shadow-lg relative overflow-hidden group hover:border-primary/50 transition-colors">
                <div className="absolute top-0 right-0 p-6 text-7xl font-serif font-black text-muted/20 select-none group-hover:text-primary/10 transition-colors">
                  {s.step}
                </div>
                <CardContent className="p-8 pt-12 flex flex-col items-center text-center relative z-10">
                  <div className="w-16 h-16 rounded-2xl bg-card border border-border flex items-center justify-center text-primary mb-6 shadow-sm">
                    <s.icon size={28} />
                  </div>
                  <h3 className="text-xl font-bold mb-3">{s.title}</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">{s.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-32 relative overflow-hidden">
        <div className="absolute inset-0 bg-primary/5" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl aspect-square bg-primary/10 rounded-full blur-[120px] pointer-events-none" />
        
        <div className="container relative z-10 px-4 text-center max-w-3xl mx-auto">
          <h2 className="text-4xl md:text-6xl font-serif font-bold mb-6">Ready to travel better?</h2>
          <p className="text-xl text-muted-foreground mb-10">
            Start exploring without an account. You’ll only need to sign in to save, resume, or request a demo booking.
          </p>
          <Link href="/planner">
            <Button size="lg" className="rounded-full h-16 px-10 text-lg font-bold shadow-xl shadow-primary/20 hover:shadow-primary/40 transition-all">
              Plan without signing in
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
