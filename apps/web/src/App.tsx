import { type ReactNode, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ClerkProvider, useAuth, useClerk } from '@clerk/react';
import { dark } from '@clerk/themes';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
  Redirect,
} from 'wouter';

import NotFound from '@/pages/not-found';
import Home from '@/pages/home';
import About from '@/pages/about';
import Research from '@/pages/research';
import Team from '@/pages/team';
import Contact from '@/pages/contact';
import Planner from '@/pages/planner';
import Advisor from '@/pages/advisor';
import Dashboard from '@/pages/dashboard';
import Bookings from '@/pages/bookings';
import Rewards from '@/pages/rewards';
import AdminChatbotQuality from '@/pages/admin-chatbot-quality';
import RecruitmentApplications from '@/pages/recruitment-applications';
import { SignInPage, SignUpPage } from '@/pages/auth';
import Privacy from '@/pages/privacy';
import Terms from '@/pages/terms';
import BookingConditions from '@/pages/booking-conditions';
import { Navbar } from '@/components/navbar';
import { Footer } from '@/components/footer';
import { SignedInSidebar } from '@/components/signed-in-sidebar';
import { didAuthenticatedUserChange } from '@/lib/auth-cache';
import {
  ANONYMOUS_AUTH_STATE,
  AppAuthProvider,
  AppAuthShow,
  useAppAuth,
  useAppClerk,
  type AppAuthState,
} from '@/lib/app-auth';
import { clerkAuthEnabled, clerkProxyUrl, clerkPublishableKey } from '@/lib/clerk-config';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

function ClerkAuthBridge({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const clerk = useClerk();
  const value = {
    authEnabled: true,
    isLoaded: Boolean(auth.isLoaded),
    isSignedIn: Boolean(auth.isSignedIn),
    userId: auth.userId ?? null,
    sessionClaims: (auth.sessionClaims ?? null) as Record<string, unknown> | null,
    user: clerk.user,
    getToken: auth.getToken,
    signOut: clerk.signOut,
    addListener: clerk.addListener,
  } as unknown as AppAuthState;
  return <AppAuthProvider value={value}>{children}</AppAuthProvider>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useAppClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (didAuthenticatedUserChange(prevUserIdRef.current, userId)) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function HomeRedirect() {
  return (
    <>
      <AppAuthShow when="signed-in">
        <Redirect to="/dashboard" />
      </AppAuthShow>
      <AppAuthShow when="signed-out">
        <Home />
      </AppAuthShow>
    </>
  );
}

function ProtectedRoute({ component: Component }: { component: any }) {
  const { isLoaded, isSignedIn } = useAppAuth();
  if (!isLoaded) return null;
  return isSignedIn ? <Component /> : <Redirect to="/sign-in" />;
}

function AdminProtectedRoute({ component: Component }: { component: any }) {
  const { user, sessionClaims, isLoaded, isSignedIn } = useAppAuth();
  const claims = sessionClaims as Record<string, any> | null | undefined;
  const isAdmin = [claims?.role, claims?.metadata?.role, claims?.publicMetadata?.role, user?.publicMetadata?.role]
    .some((role) => role === 'admin');
  if (!isLoaded) return null;
  if (!isSignedIn) return <Redirect to="/sign-in" />;
  return isAdmin ? <Component /> : <Redirect to="/" />;
}

function AdvisorProtectedRoute({ component: Component }: { component: any }) {
  const { user, sessionClaims, isLoaded, isSignedIn } = useAppAuth();
  const claims = sessionClaims as Record<string, any> | null | undefined;
  const isAdvisor = [claims?.role, claims?.metadata?.role, claims?.publicMetadata?.role, user?.publicMetadata?.role]
    .some((role) => role === 'admin' || role === 'advisor');
  if (!isLoaded) return null;
  if (!isSignedIn) return <Redirect to="/sign-in" />;
  return isAdvisor ? <Component /> : <Redirect to="/dashboard" />;
}

function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { authEnabled } = useAppAuth();
  const isAdvisor = location.startsWith('/advisor');
  const isSignedInArea = ['/dashboard', '/bookings', '/rewards', '/advisor', '/admin/chatbot-quality'].some((path) => location.startsWith(path));

  return (
    <div className={`min-h-[100dvh] flex flex-col ${isAdvisor ? 'theme-advisor' : ''}`}>
      <div className="noise-overlay" />
      <Navbar />
      <div className="relative z-10 flex flex-1 flex-col lg:flex-row">
        {authEnabled && isSignedInArea && <SignedInSidebar />}
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
      {!isAdvisor && !isSignedInArea && <Footer />}
    </div>
  );
}

function ApplicationRoutes() {
  return (
    <QueryClientProvider client={queryClient}>
      <ClerkQueryClientCacheInvalidator />
      <TooltipProvider>
        <ErrorBoundary resetKey={window.location.pathname}>
          <Layout>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/about" component={About} />
              <Route path="/research" component={Research} />
              <Route path="/team" component={Team} />
              <Route path="/contact" component={Contact} />
              <Route path="/privacy" component={Privacy} />
              <Route path="/terms" component={Terms} />
              <Route path="/booking-conditions" component={BookingConditions} />
              <Route path="/planner" component={Planner} />
              <Route path="/advisor" component={() => <AdvisorProtectedRoute component={Advisor} />} />
              <Route path="/dashboard" component={() => <ProtectedRoute component={Dashboard} />} />
              <Route path="/bookings" component={() => <ProtectedRoute component={Bookings} />} />
              <Route path="/rewards" component={() => <ProtectedRoute component={Rewards} />} />
              <Route path="/admin/chatbot-quality" component={() => <AdminProtectedRoute component={AdminChatbotQuality} />} />
              <Route path="/admin/applications" component={() => <ProtectedRoute component={RecruitmentApplications} />} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route component={NotFound} />
            </Switch>
          </Layout>
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPublishableKey}
      proxyUrl={clerkProxyUrl}
      appearance={{
        theme: dark,
        cssLayerName: "clerk",
        options: {
          logoPlacement: "inside",
          logoLinkUrl: basePath || "/",
          logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
        },
        variables: {
          colorPrimary: "hsl(190 90% 50%)",
          colorBackground: "hsl(220 30% 9%)",
          colorInput: "hsl(220 30% 18%)",
          colorInputForeground: "hsl(220 10% 98%)",
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          borderRadius: "0.75rem",
        }
      }}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Sign in to Landa Travels",
            subtitle: "Continue your responsible journey",
          },
        },
        signUp: {
          start: {
            title: "Join Landa Travels",
            subtitle: "Plan with purpose and track meaningful choices",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <ClerkAuthBridge>
        <ApplicationRoutes />
      </ClerkAuthBridge>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      {clerkAuthEnabled
        ? <ClerkProviderWithRoutes />
        : <AppAuthProvider value={ANONYMOUS_AUTH_STATE}><ApplicationRoutes /></AppAuthProvider>}
    </WouterRouter>
  );
}

export default App;
