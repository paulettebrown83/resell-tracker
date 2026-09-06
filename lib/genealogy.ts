import { requireAccess, requireWritableDeployment, supabase } from './supabase'

export const snippetFields = ['name','last_name','page_number','type','date_of_article','date_of_death',
  'location','grave_location','find_a_grave_url','maiden_name','birth_date','correct_name','relatives','brief_notes','deep_dive_notes'] as const
export type SnippetInput = Partial<Record<typeof snippetFields[number], string | null>> & { verified?: boolean; tik_tok_done?: boolean }
export type Snippet = SnippetInput & { id: number; updated_at: string | null; archived_at: string | null }
export async function getSnippets() {
  await requireAccess('genealogy')
  const rows: Snippet[] = []
  for (let from = 0; ; from += 500) {
    const { data, error } = await supabase.from('book_of_snippets').select('*').is('archived_at', null).order('id').range(from, from + 499)
    if (error) throw new Error('Could not load research records. Please try again.')
    rows.push(...data as Snippet[])
    if (data.length < 500) return rows
  }
}
export async function saveSnippet(input: SnippetInput, existing?: { id: number; updated_at: string | null }) {
  requireWritableDeployment(); await requireAccess('genealogy')
  const record = Object.fromEntries(snippetFields.map(field => [field, input[field]?.trim() || null]))
  if (!record.name) throw new Error('Enter the name as listed in the book.')
  const values = { ...record, verified: !!input.verified, tik_tok_done: !!input.tik_tok_done }
  if (!existing) {
    const { error } = await supabase.from('book_of_snippets').insert(values)
    if (error) throw new Error('Save was not confirmed. Refresh records and check before adding this person again.')
    return
  }
  let query = supabase.from('book_of_snippets').update(values).eq('id', existing.id)
  query = existing.updated_at == null ? query.is('updated_at', null) : query.eq('updated_at', existing.updated_at)
  const { data, error } = await query.select('id')
  if (error) throw new Error('Update was not confirmed. Your entered details are still in the form.')
  if (!data.length) throw new Error('This record changed elsewhere. Reload it before saving your correction.')
}
export async function archiveSnippet(id: number, updatedAt: string | null) {
  requireWritableDeployment(); await requireAccess('genealogy')
  let query = supabase.from('book_of_snippets').update({ archived_at: new Date().toISOString() }).eq('id', id)
  query = updatedAt == null ? query.is('updated_at', null) : query.eq('updated_at', updatedAt)
  const { data, error } = await query.select('id')
  if (error || !data.length) throw new Error('Archive was not confirmed. Refresh records and try again.')
}
