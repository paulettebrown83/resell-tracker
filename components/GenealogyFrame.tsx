'use client'
import { useEffect } from 'react'
import { archiveSnippet, getSnippets, saveSnippet } from '@/lib/genealogy'

declare global {
  interface Window { foundationGenealogy?: { getRecords: typeof getSnippets; saveRecord: typeof saveSnippet; archiveRecord: typeof archiveSnippet } }
}
export default function GenealogyFrame() {
  useEffect(() => {
    // The reused same-origin interface receives a narrow record API, never tokens or keys.
    window.foundationGenealogy = { getRecords: getSnippets, saveRecord: saveSnippet, archiveRecord: archiveSnippet }
    return () => { delete window.foundationGenealogy }
  }, [])
  return <iframe src="/genealogy-interface.html" title="Book of Snippets research records" className="w-full border-0 h-[calc(100vh-64px)] bg-white" />
}
