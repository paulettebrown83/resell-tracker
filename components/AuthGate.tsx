'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { Session } from '@supabase/supabase-js'
import { requireAccess, signInWithGoogle, supabase } from '@/lib/supabase'

export default function AuthGate({ children, area = 'resale' }: { children: React.ReactNode; area?: 'resale' | 'genealogy' }) {
  const [authState, setAuthState] = useState<{ session: Session | null; revision: number }>({ session: null, revision: 0 })
  const { session } = authState
  const latestRevision = useRef(0)
  const [allowedArea, setAllowedArea] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [allowedUserId, setAllowedUserId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      // Supabase can emit SIGNED_IN again on tab focus. Keep that account's
      // forms mounted while rechecking access, but never carry access across users.
      const revision = ++latestRevision.current
      setAllowedUserId(previous => previous === next?.user.id ? previous : null)
      setAuthState({ session: next, revision }); setReady(true); setError('')
    })
    return () => subscription.unsubscribe()
  }, [])
  useEffect(() => {
    let cancelled = false
    if (session) requireAccess(area).then(() => {
      if (!cancelled && latestRevision.current === authState.revision) {
        setAllowedUserId(session.user.id); setAllowedArea(area); setError('')
      }
    }).catch(() => {
      if (!cancelled && latestRevision.current === authState.revision) {
        setAllowedUserId(null)
        setError('Record access is unavailable for this account. Use the Google account Paulette approved, or ask her to check the app setup.')
      }
    })
    return () => { cancelled = true }
  }, [session, authState.revision, area])
  async function signIn() {
    setBusy(true); setError('')
    try { await signInWithGoogle() }
    catch { setError('Could not open Google sign-in. Please try again.'); setBusy(false) }
  }
  async function signOut() {
    const { error } = await supabase.auth.signOut({ scope: 'local' })
    if (error) setError('Could not sign out. Try again.')
  }
  if (!ready) return <main className="p-8 text-white">Checking sign-in…</main>
  if (session && allowedUserId === session.user.id && allowedArea === area) return <>
    {process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === 'preview' && <p className="bg-amber-100 p-3 text-center text-amber-900">Preview: records are read only. Saving is disabled.</p>}
    <div className="p-3 text-right text-white text-sm"><Link className="underline mr-4" href="/">Resale</Link><Link className="underline mr-4" href="/genealogy">Book of Snippets</Link>{session.user.email} <button className="underline ml-3" onClick={signOut}>Sign out</button></div>
    <div key={session.user.id}>{children}</div>
  </>
  return <main className="max-w-md mx-auto mt-16 bg-white rounded-lg p-6 shadow-lg">
    <h1 className="text-2xl font-bold mb-4">{area === 'genealogy' ? 'Book of Snippets' : 'Resale Tracker'}</h1>
    <p className="mb-4">Sign in with your approved account.</p>
    {error && <p role="alert" className="mb-4 text-red-700">{error}</p>}
    {session ? <button className="underline" onClick={signOut}>Sign out and use another account</button> :
      <div className="space-y-4">
        <button onClick={signIn} disabled={busy} className="bg-indigo-600 text-white rounded px-4 py-2 disabled:opacity-50">{busy ? 'Opening Google…' : 'Continue with Google'}</button>
        <p className="text-sm text-gray-600">Use the Google account Paulette approved. Signing in does not automatically grant access to records.</p>
      </div>}

  </main>
}
