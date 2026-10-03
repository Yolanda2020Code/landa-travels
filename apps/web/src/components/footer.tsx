import { Link } from "wouter";
import { Leaf, ArrowRight } from "lucide-react";
import { Button } from "./ui/button";

export function Footer() {
  return (
    <footer className="border-t border-border/40 bg-card py-12 md:py-16 mt-auto">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid grid-cols-1 gap-10 md:grid-cols-4 lg:gap-16">
          <div className="flex flex-col gap-4 md:col-span-2">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-primary text-primary-foreground">
                <Leaf size={20} />
              </div>
              <span className="font-serif text-xl font-bold tracking-tight text-foreground">Landa Travels</span>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-sm mt-2">
              Mission-driven travel planning. We combine the polish of premium booking with absolute transparency on climate and community impact. See the world without leaving a scar.
            </p>
            <div className="mt-4 flex items-center gap-4">
              <Link href="/planner">
                <Button variant="outline" className="rounded-full border-primary/20 text-primary hover:bg-primary/10">
                  Plan a trip <ArrowRight size={14} className="ml-2" />
                </Button>
              </Link>
            </div>
          </div>
          
          <div className="flex flex-col gap-3">
            <h4 className="font-bold uppercase tracking-wider text-xs text-foreground mb-2">Platform</h4>
            <Link href="/about" className="text-sm text-muted-foreground hover:text-primary transition-colors">Our Mission</Link>
            <Link href="/research" className="text-sm text-muted-foreground hover:text-primary transition-colors">Methodology & SDGs</Link>
            <Link href="/team" className="text-sm text-muted-foreground hover:text-primary transition-colors">The Team</Link>
            <Link href="/contact" className="text-sm text-muted-foreground hover:text-primary transition-colors">Contact Us</Link>
          </div>
          
          <div className="flex flex-col gap-3">
            <h4 className="font-bold uppercase tracking-wider text-xs text-foreground mb-2">Legal</h4>
            <Link href="/privacy" className="text-sm text-muted-foreground hover:text-primary transition-colors">Privacy Policy</Link>
            <Link href="/terms" className="text-sm text-muted-foreground hover:text-primary transition-colors">Terms of Service</Link>
            <Link href="/booking-conditions" className="text-sm text-muted-foreground hover:text-primary transition-colors">Booking Conditions</Link>
            <span className="text-sm text-muted-foreground mt-6 italic">© {new Date().getFullYear()} Landa Travels. All rights reserved.</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
