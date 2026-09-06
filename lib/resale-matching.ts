import { supabase, requireAccess, requireWritableDeployment } from './supabase'
import type { ResaleListing } from './resale-contract'

export interface ResaleListingMatchInput {
  listingId: string
  inventoryId: string
  expectedObservationId: string | null
  expectedInventoryId: string | null
  expectedMatchStatus: ResaleListing['match_status']
  reason: string
}
/** Explicit physical-item decision. Keep requestId + exact input on uncertain failure.
 * A retry returns its original decision snapshot; refresh workbench after success.
 * 40001 means stale evidence/link: refresh and ask for a new decision, never auto-retry.
 * Sold/archived targets reject; matching never changes stock or creates sales/actions.
 */
export async function confirmResaleListingMatch(input: ResaleListingMatchInput, requestId: string): Promise<ResaleListing> {
  requireWritableDeployment()
  await requireAccess()
  const { data, error } = await supabase.rpc('resale_confirm_listing_match', {
    p_request_id: requestId, p_payload: input,
  })
  if (error) throw error
  return data as ResaleListing
}
