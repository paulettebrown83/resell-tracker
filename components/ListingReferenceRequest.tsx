'use client';
import {useState} from 'react';
import type {ResaleListing} from '@/lib/resale-contract';
import {listingReferenceIntent} from '@/lib/listing-reference';
import {requestOperationWithRetry} from '@/lib/resale-operation-retry';
export default function ListingReferenceRequest({listing,marketplace,onChanged,pending}:{listing:ResaleListing;marketplace:string;onChanged:()=>Promise<void>;pending:boolean}) {
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 if(marketplace!=='poshmark'||!listing.external_listing_id)return null;
 async function request(){setBusy(true);setMessage('');try{await requestOperationWithRetry(listingReferenceIntent(listing));setMessage('Request saved. Awaiting an agent to check the private note; no background consumer is installed.');await onChanged();}catch{setMessage('The request was not confirmed. Use Shop activity’s pending-request recovery before trying again.');}finally{setBusy(false);}}
 return <div><button className="wb-button wb-button-secondary" disabled={pending||busy||process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV==='preview'} onClick={request}>{busy?'Saving request…':pending?'Reference request saved':'Add private tracker reference'}</button><p>{pending?"See Shop activity for the saved request. ":""}Supervised agent step. Adds this listing’s reference to seller-only Other Info; no item match needed.</p>{message&&<p role="status">{message}</p>}</div>;
}
