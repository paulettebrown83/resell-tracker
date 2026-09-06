import type { ListingPricing } from './resale-pricing'
import { supabase, requireAccess, requireWritableDeployment, type InventoryItem } from './supabase'
import type { ResaleItemDetails, ResaleAccount, ResaleListing, ResaleSnapshot, ResaleMedia, ResaleAttention, ResaleAction, ResaleItemInput, ResaleSourceRecord } from './resale-contract'

async function rows<T>(table: string, key = 'id'): Promise<T[]> {
  const result: T[] = []
  for (let from = 0; ; from += 500) {
    const { data, error } = await supabase.from(table).select('*').order(key).range(from, from + 499)
    if (error) throw error
    result.push(...data as T[])
    if (data.length < 500) return result
  }
}
export interface ResaleWorkbench {
  inventory: Array<Omit<InventoryItem, 'item_cost'> & { item_cost: number | null }>;
  details: ResaleItemDetails[]; accounts: ResaleAccount[]; listings: ResaleListing[];
  pricing?: ListingPricing[]; snapshots: ResaleSnapshot[]; media: ResaleMedia[]; attention: ResaleAttention[]; actions: ResaleAction[];
}
/** A UI read, not a transaction-consistent export. Never infer absence/sale from this response. */
export async function getResaleWorkbench(): Promise<ResaleWorkbench> {
  await requireAccess()
  const [inventory, details, accounts, listings, snapshots, media, attention, actions, pricing] = await Promise.all([
    rows<ResaleWorkbench['inventory'][number]>('inventory'), rows<ResaleItemDetails>('resale_item_details', 'inventory_id'),
    rows<ResaleAccount>('resale_accounts'), rows<ResaleListing>('resale_listings'), rows<ResaleSnapshot>('resale_snapshots'),
    rows<ResaleMedia>('resale_media'), rows<ResaleAttention>('resale_review_cases'), rows<ResaleAction>('resale_actions'), rows<ListingPricing>('resale_listing_pricing', 'listing_id'),
  ])
  return { inventory, details, accounts, listings, snapshots, media, attention, actions, pricing }
}
/** Keep requestId and the exact input until success; retrying an uncertain save uses both unchanged. */
export async function saveResaleItem(input: ResaleItemInput, requestId: string): Promise<string> {
  requireWritableDeployment()
  await requireAccess()
  const { data, error } = await supabase.rpc('resale_save_item', { p_request_id: requestId, p_payload: input })
  if (error) throw error
  return data as string
}

/** Optional report-evidence read; existing workbench shape stays unchanged. Requires the source-record migration. */
export async function getResaleSourceRecords(): Promise<ResaleSourceRecord[]> {
  await requireAccess()
  return rows<ResaleSourceRecord>('resale_source_records')
}
