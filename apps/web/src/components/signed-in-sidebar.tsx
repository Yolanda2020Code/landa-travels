import { useState } from "react";
import { useAuth, useClerk } from "@clerk/react";
import { Link, useLocation } from "wouter";
import { Award, Calendar, ChevronLeft, ChevronRight, LayoutDashboard, LogOut, Menu, MessageSquare, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getRoleAccountLinks } from "@/lib/signed-in-navigation";

const icons = {
  "/dashboard": LayoutDashboard,
  "/bookings": Calendar,
  "/rewards": Award,
  "/advisor": MessageSquare,
  "/admin/chatbot-quality": ShieldAlert,
} as const;

export function SignedInSidebar() {
  const [location] = useLocation();
  const { signOut, user } = useClerk();
  const { sessionClaims } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const claims = sessionClaims as Record<string, any> | null | undefined;
  const role = claims?.role ?? claims?.metadata?.role ?? claims?.publicMetadata?.role ?? user?.publicMetadata?.role;
  const links = getRoleAccountLinks(role).map((link) => ({ ...link, icon: icons[link.href as keyof typeof icons] }));

  const renderContent = (mobile = false) => {
    const isCollapsed = mobile ? false : collapsed;
    return (
    <>
      <div className="flex h-16 items-center justify-between border-b border-border/50 px-3">
        {!isCollapsed && <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Your account</span>}
        <Button
          variant="ghost"
          size="icon"
          className="hidden lg:inline-flex"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={isCollapsed ? "Expand account menu" : "Collapse account menu"}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </Button>
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close account menu">
          <X size={20} />
        </Button>
      </div>
      <nav aria-label="Signed-in navigation" className="flex flex-1 flex-col gap-1 p-3">
        {links.map((item) => {
          const active = location === item.href || location.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              aria-current={active ? "page" : undefined}
              title={isCollapsed ? item.label : undefined}
              className={`flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                isCollapsed ? "justify-center" : "gap-3"
              } ${active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            >
              <item.icon size={19} aria-hidden="true" />
              {!isCollapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border/50 p-3">
        <Button
          variant="ghost"
          className={`w-full text-destructive hover:bg-destructive/10 hover:text-destructive ${isCollapsed ? "px-0" : "justify-start gap-3"}`}
          title={isCollapsed ? "Log out" : undefined}
          onClick={() => signOut({ redirectUrl: "/" })}
        >
          <LogOut size={19} />
          {!isCollapsed && "Log out"}
        </Button>
      </div>
    </>
  );
  };

  return (
    <>
      <div className="sticky top-20 z-30 flex h-14 items-center border-b border-border/50 bg-background/95 px-4 backdrop-blur lg:hidden">
        <Button variant="outline" size="sm" className="gap-2" onClick={() => setMobileOpen(true)} aria-expanded={mobileOpen} aria-controls="mobile-account-menu">
          <Menu size={18} /> Account menu
        </Button>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <button className="absolute inset-0 bg-background/75 backdrop-blur-sm" onClick={() => setMobileOpen(false)} aria-label="Close account menu overlay" />
          <aside id="mobile-account-menu" className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-border bg-card shadow-2xl">
            {renderContent(true)}
          </aside>
        </div>
      )}
      <aside className={`sticky top-20 hidden h-[calc(100dvh-5rem)] shrink-0 flex-col border-r border-border/50 bg-card/60 lg:flex ${collapsed ? "w-20" : "w-64"}`}>
        {renderContent()}
      </aside>
    </>
  );
}