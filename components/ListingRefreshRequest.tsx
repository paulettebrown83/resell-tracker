'use client';
import {useState} from 'react';
import type {ResaleListing} from '@/lib/resale-contract';
import {listingRefreshIntent} from '@/lib/listing-refresh';
import {requestOperationWithRetry} from '@/lib/resale-operation-retry';
export default function ListingRefreshRequest({listing,marketplace,pending,onChanged}:{listing:ResaleListing;marketplace:string;pending:boolean;onChanged:()=>Promise<void>}){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 if(!['poshmark','mercari'].includes(marketplace)||!listing.external_listing_id)return null;
 async function request(){setBusy(true);setMessage('');try{await requestOperationWithRetry(listingRefreshIntent(listing));setMessage('Read-only check requested. Awaiting an agent; no background marketplace reader is installed.');await onChanged();}catch{setMessage('Request not confirmed. Use Shop activity’s pending-request recovery before trying again.');}finally{setBusy(false);}}
 return <div><button className="wb-button wb-button-secondary" disabled={pending||busy||process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV==='preview'} onClick={request}>{busy?'Saving request…':pending?'Listing check requested':'Check availability and pricing'}</button><p>Agent-assisted check of availability and price settings. Saved draft copy, shop fields and physical inventory stay unchanged.</p>{message&&<p role="status">{message}</p>}</div>;
}
