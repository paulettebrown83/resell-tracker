import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseKey)

// Database types
export type Sale = {
  id: string
  item_name: string
  platform: 'eBay' | 'Mercari' | 'Poshmark' | 'Depop'
  sale_date: string
  sale_price: number
  platform_fee: number
  item_cost: number
  shipping_cost: number
  profit: number
  gross_total?: number
  actual_received?: number
  status: string
  created_at: string
}

export type InventoryItem = {
  id: string
  item_name: string
  item_cost: number
  platforms: string[]
  date_added: string | null
  created_at: string
}

export type Expense = {
  id: string
  name: string
  amount: number
  date_added: string
  created_at: string
}

// API functions
export async function getSales() {
  const { data, error } = await supabase
    .from('sales')
    .select('*')
    .order('sale_date', { ascending: false })

  if (error) throw error
  return data as Sale[]
}

export async function getInventory() {
  const { data, error } = await supabase
    .from('inventory')
    .select('*')
    .order('item_name', { ascending: true })

  if (error) throw error
  return data as InventoryItem[]
}

export async function getExpenses() {
  const { data, error } = await supabase
    .from('expenses')
    .select('*')
    .order('date_added', { ascending: false })

  if (error) throw error
  return data as Expense[]
}

export async function addSale(sale: Omit<Sale, 'id' | 'created_at' | 'status'>) {
  const { data, error } = await supabase
    .from('sales')
    .insert([{ ...sale, status: 'Sold' }])
    .select()

  if (error) throw error
  return data[0] as Sale
}

export async function addInventoryItem(item: Omit<InventoryItem, 'id' | 'created_at'>) {
  const { data, error } = await supabase
    .from('inventory')
    .insert([item])
    .select()

  if (error) throw error
  return data[0] as InventoryItem
}

export async function addExpense(expense: Omit<Expense, 'id' | 'created_at'>) {
  const { data, error} = await supabase
    .from('expenses')
    .insert([expense])
    .select()

  if (error) throw error
  return data[0] as Expense
}

export async function deleteSale(id: string) {
  const { error } = await supabase
    .from('sales')
    .delete()
    .eq('id', id)

  if (error) throw error
}

export async function deleteInventoryItem(id: string) {
  const { error } = await supabase
    .from('inventory')
    .delete()
    .eq('id', id)

  if (error) throw error
}

export async function deleteExpense(id: string) {
  const { error } = await supabase
    .from('expenses')
    .delete()
    .eq('id', id)

  if (error) throw error
}
