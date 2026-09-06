import type {ResaleListing} from './resale-contract';
import type {OperationIntent} from './resale-operation-retry';
export function listingRefreshIntent(listing:ResaleListing):OperationIntent {
 if(!listing.external_listing_id)throw new Error('An exact marketplace listing ID is required.');
 return {account_id:listing.account_id,action:'import',listing_id:listing.id,inventory_id:listing.inventory_id,expected_observation_id:listing.observation_id,expected_item_version:null,requested:{scope:'exact_listing_refresh',external_listing_id:listing.external_listing_id}};
}
