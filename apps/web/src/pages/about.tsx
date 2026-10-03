import { ShieldCheck, Target, Globe, ArrowRight, HeartHandshake } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function About() {
  return (
    <div className="flex flex-col w-full animate-fade-in-up">
      {/* Hero */}
      <section className="py-24 md:py-32 relative overflow-hidden bg-background">
        <div className="absolute top-1/2 right-1/4 w-[600px] h-[600px] bg-primary/10 rounded-full blur-[100px] pointer-events-none -translate-y-1/2" />
        <div className="container px-4 md:px-6 max-w-4xl mx-auto text-center relative z-10">
          <h1 className="text-4xl md:text-6xl font-serif font-bold mb-6 leading-tight">
            Travel should leave a mark on you. <br className="hidden md:block"/>
            <span className="text-primary italic">Not the planet.</span>
          </h1>
          <p className="text-xl text-muted-foreground leading-relaxed mb-10">
            Landa Travels was born from a simple conviction: you shouldn't have to choose between a premium booking experience and responsible travel. 
          </p>
        </div>
      </section>

      {/* Principles */}
      <section className="py-24 bg-card border-y border-border/40">
        <div className="container px-4 md:px-6 max-w-6xl mx-auto">
          <h2 className="text-3xl font-serif font-bold text-center mb-16">Our Core Commitments</h2>
          
          <div className="grid md:grid-cols-3 gap-12">
            {[
              {
                icon: Globe,
                title: "Transparent Comparisons",
                desc: "If a flight is high-impact, we say so. Estimates include their source and limitations rather than implying false precision."
              },
              {
                icon: HeartHandshake,
                title: "Community First",
                desc: "Our goal is to prioritise accommodations and operators with evidence of fair wages and local benefit as partner data becomes available."
              },
              {
                icon: ShieldCheck,
                title: "Evidence-led Impact",
                desc: "Demonstration recommendations are labelled clearly. Certification and community claims must be supported before they are presented as verified."
              }
            ].map((p, i) => (
              <div key={i} className="flex flex-col text-center items-center">
                <div className="w-20 h-20 rounded-full bg-background border border-border/50 shadow-inner flex items-center justify-center text-primary mb-6">
                  <p.icon size={32} />
                </div>
                <h3 className="text-xl font-bold mb-3">{p.title}</h3>
                <p className="text-muted-foreground leading-relaxed">{p.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Mission statement */}
      <section className="py-32 bg-background">
        <div className="container px-4 md:px-6 max-w-3xl mx-auto text-center">
          <Target size={48} className="text-primary mx-auto mb-8" />
          <h2 className="text-3xl font-serif font-bold mb-6">The Landa Vision</h2>
          <p className="text-lg text-muted-foreground leading-relaxed mb-10">
            We are building a future where every journey taken actually enriches the destination. Through advanced AI and dedicated human expertise, we make the responsible choice the easiest choice. We don't preach; we empower.
          </p>
          <Link href="/research">
            <Button variant="outline" size="lg" className="rounded-full px-8 text-base border-primary/20 hover:bg-primary/5">
              Read our methodology <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
