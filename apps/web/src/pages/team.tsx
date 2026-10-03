import { Badge } from "@/components/ui/badge";
import { JoinMissionForm } from "@/components/join-mission-form";

export default function Team() {
  return (
    <div className="flex flex-col w-full animate-fade-in-up pb-24">
      {/* Hero Section */}
      <section className="pt-24 pb-16 bg-background text-center relative overflow-hidden">
        {/* Abstract atmospheric glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] bg-primary/10 blur-[100px] rounded-full pointer-events-none" />

        <div className="container px-4 max-w-4xl mx-auto relative z-10">
          <Badge variant="outline" className="mb-8 font-bold uppercase tracking-widest text-primary border-primary/20 bg-primary/5 px-4 py-1.5">
            Leadership
          </Badge>
          <h1 className="text-5xl md:text-7xl font-serif font-bold mb-6 leading-tight text-foreground">
            The Vision Behind Landa
          </h1>
          <p className="text-xl md:text-2xl text-muted-foreground leading-relaxed max-w-2xl mx-auto">
            A platform built at the intersection of technological ambition and ecological responsibility.
          </p>
        </div>
      </section>

      {/* Founder Section */}
      <section className="container px-4 md:px-6 max-w-6xl mx-auto mt-12">
        <div className="grid md:grid-cols-12 gap-12 lg:gap-20 items-center">

          <div className="md:col-span-5 relative group">
            <div className="aspect-[4/5] rounded-3xl overflow-hidden relative border border-border/50 shadow-2xl">
              {/* Cyan overlay effect on hover */}
              <div className="absolute inset-0 bg-primary/10 mix-blend-overlay z-10 transition-opacity duration-700 group-hover:opacity-0" />
              <img
                src={`${import.meta.env.BASE_URL}yolanda-nkala.webp`}
                alt="Yolanda N Nkala, founder of Landa Travels"
                className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
              />
            </div>

            {/* Decorative technical grid elements */}
            <div className="absolute -bottom-8 -right-8 w-32 h-32 border-b border-r border-primary/40 z-0 transition-all duration-700 group-hover:border-primary" />
            <div className="absolute -top-8 -left-8 w-24 h-24 border-t border-l border-border/60 z-0" />
          </div>

          <div className="md:col-span-7 space-y-8">
            <div>
              <h2 className="text-4xl md:text-5xl font-serif font-bold text-foreground mb-3">Yolanda N Nkala</h2>
              <p className="text-primary font-bold text-sm uppercase tracking-widest flex items-center gap-3">
                <span className="w-12 h-px bg-primary inline-block" />
                Founder
              </p>
            </div>

             <div className="space-y-6 text-lg text-muted-foreground leading-relaxed">
               <p>
                 Landa Travels was founded with a singular focus: leveraging data and artificial intelligence to make sustainable travel the default, rather than an alternative.
               </p>
               <p>
                  An MSc Artificial Intelligence candidate (2026) and two-time graduate of the University of Cape Town, Yolanda brings more than five years of experience in technology and data, including work at OLSPS Analytics and Discovery.
               </p>
               <p>
                 Her work is deeply rooted in the philosophy of "AI for Good," ensuring that as our systems scale, they remain firmly anchored to verifiable environmental impact and tangible community benefits.
               </p>
             </div>

             <div className="flex flex-wrap gap-3 pt-2">
               <Badge variant="secondary" className="px-4 py-2 rounded-full text-sm font-medium bg-secondary/50 hover:bg-secondary/80 border-transparent transition-colors">
                 MSc AI Candidate '26
               </Badge>
               <Badge variant="secondary" className="px-4 py-2 rounded-full text-sm font-medium bg-secondary/50 hover:bg-secondary/80 border-transparent transition-colors">
                 UCT Alumni
               </Badge>
               <Badge variant="secondary" className="px-4 py-2 rounded-full text-sm font-medium bg-secondary/50 hover:bg-secondary/80 border-transparent transition-colors">
                 Data & Analytics
               </Badge>
               <Badge className="px-4 py-2 rounded-full text-primary font-bold bg-primary/10 hover:bg-primary/20 border-primary/30 transition-colors shadow-[0_0_15px_rgba(var(--primary),0.2)]">
                 AI for Good
               </Badge>
             </div>
          </div>
        </div>
      </section>

      {/* Join the Mission Section */}
      <section className="container px-4 md:px-6 max-w-6xl mx-auto mt-32 relative">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent rounded-[3rem] -z-10" />

        <div className="grid lg:grid-cols-12 gap-12 lg:gap-16 items-start p-8 md:p-12 lg:p-16 border border-border/60 rounded-[3rem] bg-card/20 backdrop-blur-sm shadow-xl">
          <div className="lg:col-span-5 space-y-8 lg:sticky lg:top-28">
            <div>
              <h2 className="text-4xl md:text-5xl font-serif font-bold mb-4">Join the Mission</h2>
              <p className="text-xl text-primary font-medium">
                Build the future of travel.
              </p>
            </div>

            <div className="space-y-6 text-base md:text-lg text-muted-foreground leading-relaxed">
              <p>
                We are actively seeking technologists, climate researchers, and travel industry veterans who share our ambition.
              </p>
              <p>
                If you believe that responsible travel requires rigorous data, intuitive design, and transparent architecture, we want to hear from you. We value intellectual honesty, rigorous optimism, and a drive to build systems that scale responsibly.
              </p>
            </div>

            <div className="space-y-5 pt-6 border-t border-border/60">
              <h3 className="font-bold text-foreground tracking-wide uppercase text-sm">Current areas of interest</h3>
              <ul className="space-y-4">
                {[
                  "LLM orchestration and safety",
                  "Climate data modeling",
                  "Sustainable travel partnerships",
                  "Frontend design engineering"
                ].map((item, i) => (
                  <li key={i} className="flex gap-4 items-center text-muted-foreground font-medium">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary ring-4 ring-primary/20 shadow-[0_0_10px_rgba(var(--primary),0.5)]" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="lg:col-span-7 bg-background/80 backdrop-blur-md rounded-2xl p-6 md:p-10 border border-border/80 shadow-2xl relative">
            {/* Subtle glow behind the form */}
            <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 blur-[80px] rounded-full pointer-events-none -z-10" />
            <JoinMissionForm />
          </div>
        </div>
      </section>
    </div>
  );
}
