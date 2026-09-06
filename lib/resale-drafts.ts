import {supabase,requireAccess,requireWritableDeployment} from './supabase'
import type {ResaleListing} from './resale-contract'
import type {DraftFields,DraftChannel,WritingPreferences} from './listing-guidance'
export interface ListingDraftInput {
 listing_id?:string;account_id:string;inventory_id:string;expected_version:number
 channel:DraftChannel;rules_version:string;fields:DraftFields;preferences?:WritingPreferences;overrides?:Partial<DraftFields>
}
export interface PreparedListing extends ResaleListing {
 draft_version:number;draft_updated_at:string|null
 draft_context:{inventory_id?:string;account_id?:string;rules_version?:string;channel?:DraftChannel;fields?:DraftFields;preferences?:WritingPreferences;overrides?:Partial<DraftFields>}
}
/** Save locally prepared fields only; never publishes or changes observed marketplace state.
 * Keep requestId + exact input after uncertain errors. Exact retry returns its original snapshot;
 * reload current rows afterward. 40001 requires reload and a fresh reviewed edit, not automatic replay.
 */
export async function saveListingDraft(input:ListingDraftInput,requestId:string):Promise<PreparedListing>{
 requireWritableDeployment();await requireAccess()
 const {data,error}=await supabase.rpc('resale_save_listing_draft',{p_request_id:requestId,p_payload:input})
 if(error)throw error
 return data as PreparedListing
}

/** A later explicit re-match never makes old copy/photos true for the newly linked item. */
export function isPreparedDraftCurrent(listing:PreparedListing):boolean {
 return listing.draft_version>0 && listing.draft_context.inventory_id===listing.inventory_id && listing.draft_context.account_id===listing.account_id
}
