import { SignIn, SignUp } from "@clerk/react";
import { clerkAuthEnabled } from "@/lib/clerk-config";
import { isEmbeddedWindow } from "@/lib/auth-navigation";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function AuthUnavailable() {
  return (
    <div role="status" className="rounded-2xl border border-border bg-card/80 p-6 text-center">
      <h1 className="font-serif text-xl font-bold">Account access is unavailable</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        This demonstration is running without an account provider. You can plan
        a trip without signing in, but saving a trip, account pages, and account
        based advisor features are disabled for this deployment.
      </p>
    </div>
  );
}

function EmbeddedAuth({ mode }: { mode: "sign-in" | "sign-up" }) {
  const url = `${window.location.origin}${basePath}/${mode}`;
  return (
    <section className="rounded-2xl border border-border bg-card p-6 text-center">
      <h1 className="font-serif text-2xl font-bold">Open secure account access</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        This preview is embedded in another website. Open Landa Travels directly
        to sign in securely and avoid blocked Google sign-in windows.
      </p>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-5 inline-flex min-h-12 items-center justify-center rounded-xl bg-primary px-6 py-3 font-semibold text-primary-foreground"
      >
        {mode === "sign-in" ? "Open secure sign-in" : "Open secure sign-up"}
      </a>
      <p className="mt-4 break-words text-sm text-muted-foreground">
        If an in-app browser shows a blank window, open this link in Safari or Chrome:
        {" "}<a href={url} target="_blank" rel="noopener noreferrer" className="underline">{url}</a>
      </p>
    </section>
  );
}

export function SignInPage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-[calc(100dvh-80px)] bg-background relative overflow-hidden p-4">
      {/* Decorative background blur */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="relative z-10 w-full max-w-md">
        <p className="mb-4 text-center text-sm text-muted-foreground">Sign in to save your plan, resume a saved trip, or request a demo booking. Planning itself is open to everyone.</p>
        {clerkAuthEnabled
          ? isEmbeddedWindow(typeof window === "undefined" ? undefined : window)
            ? <EmbeddedAuth mode="sign-in" />
            : <SignIn oauthFlow="redirect" routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
          : <AuthUnavailable />}
      </div>
    </div>
  );
}

export function SignUpPage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-[calc(100dvh-80px)] bg-background relative overflow-hidden p-4">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="relative z-10 w-full max-w-md">
        <p className="mb-4 text-center text-sm text-muted-foreground">Create an account when you’re ready to save, resume, or request a demo booking.</p>
        {clerkAuthEnabled
          ? isEmbeddedWindow(typeof window === "undefined" ? undefined : window)
            ? <EmbeddedAuth mode="sign-up" />
            : <SignUp oauthFlow="redirect" routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
          : <AuthUnavailable />}
      </div>
    </div>
  );
}
