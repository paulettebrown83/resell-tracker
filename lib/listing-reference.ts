import type { ResaleListing } from './resale-contract';
import type { OperationIntent } from './resale-operation-retry';
export const REFERENCE_SCOPE='poshmark_private_listing_reference';
export function listingReferenceIntent(listing:ResaleListing):OperationIntent {
 if (!listing.external_listing_id) throw new Error('This listing needs an exact marketplace ID.');
 return {account_id:listing.account_id,action:'update',listing_id:listing.id,inventory_id:listing.inventory_id,expected_observation_id:listing.observation_id,expected_item_version:null,requested:{scope:REFERENCE_SCOPE,external_listing_id:listing.external_listing_id}};
}
/** Pure supervised-consumer decision. No network, credentials, browser, or stock writes. */
export function referenceReadbackDecision(input:{listingId:string;currentNote:string;expectedNote?:string;verifyOnly:boolean;protectedMatch:boolean;leaseExpiresAt:string;now?:number}):{step:'write_note'|'verify_saved'|'stop';note?:string;reason:string} {
 const now=input.now??Date.now(),expiry=Date.parse(input.leaseExpiresAt);
 if (!Number.isFinite(expiry)||expiry<=now+15000) return {step:'stop',reason:'Lease expired or too close to expiry. Request a fresh supervised read.'};
 if (!input.protectedMatch) return {step:'stop',reason:'Another editor field changed. Preserve the unresolved result.'};
 const marker=`Resale tracker listing: ${input.listingId}`;
 if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.listingId)||input.currentNote.length>500) return {step:'stop',reason:'Invalid exact target or note limit.'};
 const has=input.currentNote.split('\n').includes(marker),expected=input.expectedNote??(has?input.currentNote:input.currentNote+(input.currentNote?'\n':'')+marker);
 if (expected.length>500) return {step:'stop',reason:'The existing note has no room. Nothing will be replaced.'};
 if (input.currentNote===expected&&has) return {step:'verify_saved',reason:'Exact marker already present. Read back and verify without another save.'};
 if (input.verifyOnly||has||expected!==input.currentNote+(input.currentNote?'\n':'')+marker) return {step:'stop',reason:'The saved note differs from the expected result. Do not retry the write.'};
 return {step:'write_note',note:expected,reason:'Change only Other Info once, then reopen and verify the exact listing.'};
}
