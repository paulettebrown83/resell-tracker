"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { requireAccess, signInWithGoogle, supabase } from "@/lib/supabase";

export default function AuthGate({
  children,
  area = "resale",
}: {
  children: React.ReactNode;
  area?: "resale" | "genealogy";
}) {
  const [authState, setAuthState] = useState<{
    session: Session | null;
    revision: number;
  }>({ session: null, revision: 0 });
  const { session } = authState;
  const latestRevision = useRef(0);
  const [allowedArea, setAllowedArea] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [allowedUserId, setAllowedUserId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => {
      // Supabase can emit SIGNED_IN again on tab focus. Keep that account's
      // forms mounted while rechecking access, but never carry access across users.
      const revision = ++latestRevision.current;
      setAllowedUserId((previous) =>
        previous === next?.user.id ? previous : null,
      );
      setAuthState({ session: next, revision });
      setReady(true);
      setError("");
    });
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (session)
      requireAccess(area)
        .then(() => {
          if (!cancelled && latestRevision.current === authState.revision) {
            setAllowedUserId(session.user.id);
            setAllowedArea(area);
            setError("");
          }
        })
        .catch(() => {
          if (!cancelled && latestRevision.current === authState.revision) {
            setAllowedUserId(null);
            setError(
              "Record access is unavailable for this account. Use the Google account Paulette approved, or ask her to check the app setup.",
            );
          }
        });
    return () => {
      cancelled = true;
    };
  }, [session, authState.revision, area]);
  async function signIn() {
    setBusy(true);
    setError("");
    try {
      await signInWithGoogle();
    } catch {
      setError("Could not open Google sign-in. Please try again.");
      setBusy(false);
    }
  }
  async function signOut() {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) setError("Could not sign out. Try again.");
  }
  if (!ready)
    return (
      <main className="wb-auth-loading" role="status">
        Checking sign-in…
      </main>
    );
  if (session && allowedUserId === session.user.id && allowedArea === area)
    return (
      <>
        {process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === "preview" && (
          <p className="wb-preview-banner">
            Preview: records are read only. Saving is disabled.
          </p>
        )}
        <div className="wb-account-bar">
          <Link href="/">Resale studio</Link>
          <Link href="/genealogy">Book of Snippets</Link>
          <span className="wb-account-email">{session.user.email}</span>
          <button onClick={signOut}>Sign out</button>
        </div>
        {error && (
          <p className="wb-alert" role="alert">
            {error}
          </p>
        )}
        <div key={session.user.id}>{children}</div>
      </>
    );
  return (
    <div className="wb-auth-shell">
      <aside className="wb-auth-story">
        <div className="wb-brand" aria-hidden="true">
          <span className="wb-brand-mark">
            r<span>.</span>
          </span>
          <span>
            resale<span>PAULETTE’S WORKSPACE</span>
          </span>
        </div>
        <p className="wb-eyebrow">LESS SEARCHING. MORE SELLING.</p>
        <h2>
          A little space.
          <br />A fresh chapter.
        </h2>
        <p>
          Your items, photos, and sales deserve a place where the details stay
          together.
        </p>
        <small>ONE ITEM. ONE RECORD. YOUR STORY.</small>
      </aside>
      <main className="wb-auth-main">
        <div className="wb-auth-card">
          <p className="wb-eyebrow">YOUR PRIVATE WORKSPACE</p>
          <h1>{area === "genealogy" ? "Book of Snippets" : "Welcome back."}</h1>
          <p>Sign in to pick up where you left off.</p>
          {error && (
            <p role="alert" className="wb-alert">
              {error}
            </p>
          )}
          {session ? (
            <button className="wb-button wb-button-secondary" onClick={signOut}>
              Sign out and use another account
            </button>
          ) : (
            <>
              <button
                onClick={signIn}
                disabled={busy}
                className="wb-button wb-button-primary"
              >
                {busy ? "Opening Google…" : "Continue with Google"}
              </button>
              <p className="wb-help">
                Use the Google account Paulette approved. Signing in does not
                automatically grant access to records.
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
