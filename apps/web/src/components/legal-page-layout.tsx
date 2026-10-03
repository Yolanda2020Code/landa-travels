import { type ReactNode, useEffect } from "react";
import { Link } from "wouter";

interface LegalPageLayoutProps {
  title: string;
  description: string;
  lastUpdated: string;
  icon: ReactNode;
  children: ReactNode;
  sections: { id: string; title: string }[];
}

export function LegalPageLayout({ title, description, lastUpdated, icon, children, sections }: LegalPageLayoutProps) {
  useEffect(() => {
    const sectionId = window.location.hash.slice(1);
    if (!sectionId) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(sectionId)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const previousTitle = document.title;
    const upsertMeta = (selector: string, attributes: Record<string, string>, content: string) => {
      let element = document.head.querySelector<HTMLMetaElement>(selector);
      const created = !element;
      const previousContent = element?.content;
      if (!element) {
        element = document.createElement("meta");
        Object.entries(attributes).forEach(([key, value]) => element?.setAttribute(key, value));
        document.head.appendChild(element);
      }
      element.content = content;
      return () => {
        if (created) element?.remove();
        else if (previousContent != null && element) element.content = previousContent;
      };
    };

    document.title = `${title} | Landa Travels`;
    const restoreDescription = upsertMeta('meta[name="description"]', { name: "description" }, description);
    const restoreOgTitle = upsertMeta('meta[property="og:title"]', { property: "og:title" }, `${title} | Landa Travels`);
    const restoreOgDescription = upsertMeta('meta[property="og:description"]', { property: "og:description" }, description);

    return () => {
      document.title = previousTitle;
      restoreDescription();
      restoreOgTitle();
      restoreOgDescription();
    };
  }, [description, title]);

  return (
    <div className="flex-1 flex flex-col items-center p-4 md:p-8 lg:p-12 py-12 lg:py-16 animate-fade-in-up">
      <div className="max-w-6xl w-full grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12 lg:gap-16">
        
        {/* Sidebar */}
        <aside className="md:col-span-4 lg:col-span-3 space-y-8 order-1">
          <div className="md:sticky md:top-28 space-y-8 glass-panel p-6 rounded-2xl">
            <div>
              <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mb-5 shadow-inner">
                {icon}
              </div>
              <h1 className="text-2xl font-serif font-bold mb-3 leading-tight text-foreground">{title}</h1>
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Effective Date<br/><span className="text-foreground/80 mt-1 block normal-case font-normal text-sm">{lastUpdated}</span>
              </div>
            </div>
            
            <nav className="hidden md:flex flex-col space-y-3">
              <span className="text-xs font-bold uppercase tracking-wider text-primary mb-1">In this document</span>
              {sections.map(s => (
                <a 
                  key={s.id} 
                  href={`#${s.id}`} 
                  className="text-sm text-muted-foreground hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
                >
                  {s.title}
                </a>
              ))}
            </nav>

            <div className="hidden md:block pt-6 border-t border-border/50">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3 block">Legal Directory</span>
              <nav className="flex flex-col space-y-3">
                <Link href="/privacy" className="text-sm text-foreground/80 hover:text-primary transition-colors">Privacy Policy</Link>
                <Link href="/terms" className="text-sm text-foreground/80 hover:text-primary transition-colors">Terms of Service</Link>
                <Link href="/booking-conditions" className="text-sm text-foreground/80 hover:text-primary transition-colors">Booking Conditions</Link>
              </nav>
            </div>
          </div>
        </aside>

        {/* Content */}
        <div className="md:col-span-8 lg:col-span-9 order-2">
          <div className="glass-panel p-6 md:p-10 lg:p-12 rounded-2xl">
            <div className="prose prose-sm md:prose-base dark:prose-invert max-w-none prose-headings:font-serif prose-headings:font-bold prose-headings:text-foreground prose-p:leading-relaxed prose-p:text-muted-foreground prose-a:text-primary hover:prose-a:text-primary/80 prose-li:text-muted-foreground prose-strong:text-foreground">
              {children}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}