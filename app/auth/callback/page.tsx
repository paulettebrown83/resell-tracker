'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { completeGoogleSignIn } from '@/lib/supabase'

export default function AuthCallback() {
  const completion = useRef<Promise<void> | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    if (!completion.current) {
      const search = window.location.search
      // Remove the one-use code and provider error text from browser history.
      window.history.replaceState(null, '', '/auth/callback')
      completion.current = completeGoogleSignIn(search)
    }
    // Reuse the same exchange across Strict Mode's repeated effects.
    completion.current.then(() => {
      if (active) window.location.replace('/')
    }).catch(() => {
      if (active) setError('Google sign-in could not finish. Please start again in this browser.')
    })
    return () => { active = false }
  }, [])
  return <main className="max-w-md mx-auto mt-16 bg-white rounded-lg p-6 shadow-lg">
    <h1 className="text-2xl font-bold mb-4">Resale Tracker</h1>
    {error ? <><p role="alert" className="mb-4 text-red-700">{error}</p><Link className="underline" href="/">Back to sign-in</Link></> :
      <p role="status">Finishing Google sign-in…</p>}
  </main>
}
