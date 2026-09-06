'use client'
import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { requireAccess, supabase } from '@/lib/supabase'

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<{ session: Session | null; revision: number }>({ session: null, revision: 0 })
  const { session } = authState
  const latestRevision = useRef(0)
  const [ready, setReady] = useState(false)
  const [allowedUserId, setAllowedUserId] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
    if (session) requireAccess().then(() => {
      if (!cancelled && latestRevision.current === authState.revision) {
        setAllowedUserId(session.user.id); setError('')
      }
    }).catch(() => {
      if (!cancelled && latestRevision.current === authState.revision) {
        setAllowedUserId(null)
        setError('Resale access is unavailable for this account. Ask Paulette or Jon to check your access and the app setup.')
      }
    })
    return () => { cancelled = true }
  }, [session, authState.revision])
  async function signIn(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('')
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setError('Sign-in failed. Check your email and password.')
      else setPassword('')
    } catch { setError('Could not connect. Try again.') }
    finally { setBusy(false) }
  }
  async function signOut() {
    const { error } = await supabase.auth.signOut({ scope: 'local' })
    if (error) setError('Could not sign out. Try again.')
  }
  if (!ready) return <main className="p-8 text-white">Checking sign-in…</main>
  if (session && allowedUserId === session.user.id) return <>
    {process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === 'preview' && <p className="bg-amber-100 p-3 text-center text-amber-900">Preview: records are read only. Saving is disabled.</p>}
    <div className="p-3 text-right text-white text-sm">{session.user.email} <button className="underline ml-3" onClick={signOut}>Sign out</button></div>
    <div key={session.user.id}>{children}</div>
  </>
  return <main className="max-w-md mx-auto mt-16 bg-white rounded-lg p-6 shadow-lg">
    <h1 className="text-2xl font-bold mb-4">Resale Tracker</h1>
    <p className="mb-4">Sign in with your approved account.</p>
    {error && <p role="alert" className="mb-4 text-red-700">{error}</p>}
    {session ? <button className="underline" onClick={signOut}>Sign out and use another account</button> :
      <form onSubmit={signIn} className="space-y-4">
        <label className="block">Email<input className="block border rounded w-full p-2" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label className="block">Password<input className="block border rounded w-full p-2" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
        <button disabled={busy} className="bg-indigo-600 text-white rounded px-4 py-2 disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="text-sm text-gray-600">For account setup or a password reset, contact Paulette or Jon.</p>
      </form>}
  </main>
}
