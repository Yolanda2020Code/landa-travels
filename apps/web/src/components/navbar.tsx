import { Link, useLocation } from "wouter";
import { Leaf, Menu, User as UserIcon, X } from "lucide-react";
import { Button } from "./ui/button";
import { useState } from "react";
import { AppAuthShow, useAppAuth } from "@/lib/app-auth";

export function Navbar() {
  const [location] = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const { user, sessionClaims, authEnabled } = useAppAuth();

  const claims = sessionClaims as Record<string, any> | null | undefined;
  const role = claims?.role ?? claims?.metadata?.role ?? claims?.publicMetadata?.role ?? user?.publicMetadata?.role;
  const isAdmin = role === 'admin';
  const isAdvisor = isAdmin || role === 'advisor';

  const navLinks = [
    { label: "About", href: "/about" },
    { label: "Research", href: "/research" },
    { label: "Team", href: "/team" },
    { label: "Contact", href: "/contact" },
    { label: "Planner", href: "/planner" },
  ];

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl transition-colors">
      <div className="container mx-auto px-4 md:px-6 flex h-20 items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-80">
          <div className={`p-2 rounded-xl flex items-center justify-center ${isAdvisor ? 'bg-primary text-primary-foreground' : 'bg-primary text-primary-foreground'}`}>
            <Leaf size={24} className={isAdvisor ? "" : "text-background"} />
          </div>
          <div className="flex flex-col">
            <span className="font-serif text-xl font-bold leading-none tracking-tight">Landa Travels</span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-primary mt-0.5">Responsible Journeys</span>
          </div>
        </Link>

        {/* Desktop Nav */}
        <nav className="hidden md:flex items-center gap-8">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`text-sm font-medium transition-colors hover:text-primary ${
                location === link.href ? "text-primary" : "text-muted-foreground"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden md:flex items-center gap-4">
          <AppAuthShow when="signed-out">
            {authEnabled
              ? <Link href="/sign-in" className="text-sm font-medium text-muted-foreground hover:text-foreground">Sign In</Link>
              : <span className="text-xs text-muted-foreground">Account sign-in is unavailable in this demo.</span>}
            <Link href="/planner">
              <Button className="rounded-full px-6 font-semibold shadow-lg hover:shadow-primary/25 transition-all">
                Plan without signing in
              </Button>
            </Link>
          </AppAuthShow>

          <AppAuthShow when="signed-in">
            <Link href="/dashboard" className="flex items-center gap-2 rounded-full border border-border/50 bg-card/50 py-2 pl-2 pr-4 text-sm font-medium hover:border-primary/50">
              <div className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-primary/20">
                {user?.imageUrl ? <img src={user.imageUrl} alt="" className="h-full w-full object-cover" /> : <UserIcon size={14} className="text-primary" />}
              </div>
              Account
            </Link>
          </AppAuthShow>
        </div>

        {/* Mobile Toggle */}
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setIsOpen(!isOpen)}>
          {isOpen ? <X /> : <Menu />}
        </Button>
      </div>

      {/* Mobile Nav */}
      {isOpen && (
        <div className="md:hidden border-t border-border/50 bg-background/95 backdrop-blur-xl absolute top-20 left-0 w-full p-4 flex flex-col gap-4 shadow-2xl z-50">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setIsOpen(false)}
              className="text-lg font-medium p-2"
            >
              {link.label}
            </Link>
          ))}
          <div className="h-px w-full bg-border/50 my-2" />
          <AppAuthShow when="signed-out">
            {authEnabled
              ? <Link href="/sign-in" onClick={() => setIsOpen(false)} className="text-lg font-medium p-2">Sign In</Link>
              : <p role="status" className="px-2 text-sm text-muted-foreground">Account sign-in is unavailable in this demo.</p>}
            <Link href="/planner" onClick={() => setIsOpen(false)}>
              <Button className="w-full mt-2 rounded-xl h-12 text-lg">Plan without signing in</Button>
            </Link>
          </AppAuthShow>
          <AppAuthShow when="signed-in">
            <Link href="/dashboard" onClick={() => setIsOpen(false)} className="text-lg font-medium p-2">Dashboard</Link>
            {isAdmin && (
              <Link href="/admin/chatbot-quality" onClick={() => setIsOpen(false)} className="text-lg font-medium p-2">Quality Control</Link>
            )}
          </AppAuthShow>
        </div>
      )}
    </header>
  );
}
