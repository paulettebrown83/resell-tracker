import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { flowType: 'pkce', detectSessionInUrl: false }
})

// Google secrets stay in Supabase's provider configuration. The browser only starts the OAuth flow.
export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: new URL('/auth/callback', window.location.origin).href,
      queryParams: { prompt: 'select_account' }
    }
  })
  if (error) throw new Error('Google sign-in could not start. Please try again.')
}
export async function completeGoogleSignIn(search: string) {
  const params = new URLSearchParams(search)
  if (params.has('error') || params.has('error_code')) {
    throw new Error('Google sign-in was cancelled or could not finish. Please start again.')
  }
  const code = params.get('code')
  if (!code || params.getAll('code').length !== 1 || params.getAll('sb_flow_id').length > 1) {
    throw new Error('This sign-in link is incomplete. Please start Google sign-in again.')
  }
  const flowId = params.get('sb_flow_id') || undefined
  const { data, error } = await supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined)
  if (error || !data.session) throw new Error('This sign-in link expired or could not be verified. Please start again in this browser.')
}

export type Sale = {
  id: string; item_name: string; platform: string; sale_date: string
  sale_price: number; platform_fee: number; item_cost: number | null; shipping_cost: number | null
  profit: number; gross_total: number | null; actual_received: number | null
  status: string; created_at: string; inventory_id: string | null
  source_system: string | null; source_record_id: string | null
  settlement_status: string; version: number
}
export type InventoryItem = {
  id: string; item_name: string; item_cost: number | null; platforms: string[]
  date_added: string | null; created_at: string; status: string | null; archived_at: string | null
}
export type Expense = {
  id: string; name: string; amount: number; date_added: string; created_at: string; archived_at: string | null
}
export type SaleInput = {
  id?: string; version?: number; inventory_id?: string; item_name?: string; platform?: string
  sale_date?: string; sale_price?: number; platform_fee?: number; item_cost?: number
  shipping_cost?: number; gross_total?: number; actual_received?: number
  reason?: string; void?: boolean; source_system?: string; source_record_id?: string
}
export function requireWritableDeployment() {
  if (process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === 'preview') {
    throw new Error('This preview is read only. Use the production app to save records.')
  }
}
export async function requireAccess(area: 'resale' | 'genealogy' = 'resale') {
  const { data, error } = await supabase.rpc(area === 'genealogy' ? 'genealogy_access' : 'resale_access')
  if (error) throw error
  if (!data) throw new Error('This account has not been granted access to these records.')
}
// Page in stable primary-key order: Supabase's default response limit must not truncate exports.
async function allRows<T>(table: string, primaryKey = 'id'): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += 500) {
    const { data, error } = await supabase.from(table).select('*').order(primaryKey).range(from, from + 499)
    if (error) throw error
    rows.push(...data as T[])
    if (data.length < 500) return rows
  }
}
export async function getSales() { return (await allRows<Sale>('sales')).filter(s => s.status?.toLowerCase() !== 'void') }
export async function getInventory() {
  return (await allRows<InventoryItem>('inventory')).filter(i => !i.archived_at && i.status?.toLowerCase() !== 'sold')
    .map(i => ({ ...i, platforms: i.platforms || [] }))
}
export async function getExpenses() { return (await allRows<Expense>('expenses')).filter(e => !e.archived_at) }

async function pendingKey() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Sign in before saving.')
  return `resale-pending:${session.user.id}`
}
// Preserve uncertain requests across a reload. Never silently start a second sale after a network failure.
export async function saveSale(payload: SaleInput) {
  requireWritableDeployment()
  const key = await pendingKey()
  const old = sessionStorage.getItem(key)
  if (old) throw new Error('A previous sale request needs verification. Use Retry pending save first.')
  const request = { id: crypto.randomUUID(), payload }
  sessionStorage.setItem(key, JSON.stringify(request))
  return sendPending(key, request)
}
async function sendPending(key: string, request: { id: string; payload: SaleInput }, isRetry = false) {
  const { data, error } = await supabase.rpc('save_sale', { p_request_id: request.id, p_payload: request.payload })
  if (error) {
    // PostgreSQL statement errors prove rollback; transport errors may hide a committed response.
    if (/^(22|23|42|P0|40001)/.test(error.code || '') && !(isRetry && error.code === '42501')) sessionStorage.removeItem(key)
    if (error.code === '23505') throw new Error('This source record or inventory item already has a sale. Reload and review it before adding another.')
    throw new Error(error.message || 'Save was not confirmed. Retry pending save before adding another sale.')
  }
  sessionStorage.removeItem(key)
  return data as Sale
}
export async function retryPendingSale() {
  requireWritableDeployment()
  const key = await pendingKey(), raw = sessionStorage.getItem(key)
  if (!raw) throw new Error('No pending save in this browser tab.')
  return sendPending(key, JSON.parse(raw), true)
}
export async function addInventoryItem(item: Pick<InventoryItem, 'item_name' | 'item_cost' | 'platforms' | 'date_added'>) {
  requireWritableDeployment()
  const { error } = await supabase.from('inventory').insert(item)
  if (error) throw error
}
export async function addExpense(item: Pick<Expense, 'name' | 'amount' | 'date_added'>) {
  requireWritableDeployment()
  const { error } = await supabase.from('expenses').insert(item)
  if (error) throw error
}
async function archive(table: 'inventory' | 'expenses', id: string) {
  requireWritableDeployment()
  const { data, error } = await supabase.from(table).update({ archived_at: new Date().toISOString() }).eq('id', id).select('id')
  if (error) throw error
  if (!data.length) throw new Error('Record was not updated. Check access and reload.')
}
export const archiveInventoryItem = (id: string) => archive('inventory', id)
export const archiveExpense = (id: string) => archive('expenses', id)
export async function exportRecords() {
  await requireAccess()
  const names = ['sales', 'inventory', 'expenses', 'resell_clothes', 'sale_history',
    'resale_item_details', 'resale_accounts', 'resale_snapshots', 'resale_listings',
    'resale_observations', 'resale_order_lines', 'resale_order_events', 'resale_media',
    'resale_review_cases', 'resale_actions', 'resale_action_attempts',
    'resale_source_records', 'resale_listing_match_history', 'resale_listing_draft_history', 'resale_operation_proposals', 'resale_operation_verifications']
  const tables = Object.fromEntries(await Promise.all(names.map(async name => [name, await allRows(name, name === 'resale_item_details' ? 'inventory_id' : 'id')])))
  return { format: 'resale-record-export-v1', exported_at: new Date().toISOString(), tables }
}
