import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {createHash,createPublicKey,verify} from 'node:crypto';
export const SCOPE='https://api.ebay.com/oauth/api_scope';
export const CALLBACK='https://resell-tracker-beta.vercel.app/api/integrations/ebay/callback';
export const DELETION='https://resell-tracker-beta.vercel.app/api/integrations/ebay/deletion';
export class EbayError extends Error {constructor(code,status=503){super(code);this.code=code;this.status=status;}}
export const hash=value=>createHash('sha256').update(value).digest('hex');
const parser=new XMLParser({ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false,trimValues:false,processEntities:true,ignoreDeclaration:true});
const many=v=>v===undefined?[]:Array.isArray(v)?v:[v];
const text=(v,max=300)=>typeof v==='string'&&v.length>0&&v.length<=max?v:null;
const integer=v=>typeof v==='string'&&/^\d{1,9}$/.test(v)?Number(v):null;
const date=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const escape=v=>String(v).replace(/[<>&'\"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
export async function bounded(response,limit){const reader=response.body?.getReader();if(!reader)throw new EbayError('empty_response');let bytes=0,parts=[];try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit)throw new EbayError('response_too_large');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));}
export function xmlResponse(raw,call){
 if(/<!DOCTYPE|<!ENTITY/i.test(raw)||XMLValidator.validate(raw)!==true)throw new EbayError('invalid_xml');
 const root=parser.parse(raw)[`${call}Response`];
 if(!root||root['@_xmlns']!=='urn:ebay:apis:eBLBaseComponents'||Array.isArray(root))throw new EbayError('invalid_xml');
 if(root.Ack!=='Success')throw new EbayError(root.Ack==='Warning'?'provider_warning':'provider_rejected',409);
 return root;
}
export function identity(raw){const u=xmlResponse(raw,'GetUser').User;if(!u||Array.isArray(u)||!text(u.EIASToken,512)||!text(u.UserID,128))throw new EbayError('seller_identity_unavailable',409);return {handle:u.UserID,eias_token:u.EIASToken};}
function money(v){const value=text(v?.['#text'],30),currency=text(v?.['@_currencyID'],3);return value&&/^\d{1,12}(\.\d{1,4})?$/.test(value)&&/^[A-Z]{3}$/.test(currency||'')?{value,currency}:null;}
export function listingPage(raw,page){const root=xmlResponse(raw,'GetMyeBaySelling'),active=root.ActiveList;
 if(!active||!Number.isInteger(page)||page<1)throw new EbayError('invalid_listing_page');
 const total=integer(active.PaginationResult?.TotalNumberOfPages),count=integer(active.PaginationResult?.TotalNumberOfEntries),items=many(active.ItemArray?.Item);
 if(total===null||count===null||items.length>50||(total>0&&page>total))throw new EbayError('invalid_listing_page');
 const records=items.map(i=>{if(!/^\d{9,15}$/.test(i.ItemID||''))throw new EbayError('missing_listing_id');return {listing_id:i.ItemID,title:text(i.Title,500),sku:text(i.SKU,128),listing_type:text(i.ListingType,60),observed_status:'active',quantity_available:integer(i.QuantityAvailable),quantity_total:integer(i.Quantity),current_price:money(i.SellingStatus?.CurrentPrice),has_variations:i.Variations!==undefined};});
 if(new Set(records.map(r=>r.listing_id)).size!==records.length)throw new EbayError('duplicate_listing_id');
 return {records,page,total_pages:total,total_entries:count,has_more:page<total,coverage:'active_only'};
}
export function orderPage(raw,page,seller){const root=xmlResponse(raw,'GetOrders'),orders=many(root.OrderArray?.Order),total=integer(root.PaginationResult?.TotalNumberOfPages),count=integer(root.PaginationResult?.TotalNumberOfEntries);
 if(total===null||count===null||orders.length>50||!['true','false'].includes(root.HasMoreOrders)||(total>0&&page>total)||(root.HasMoreOrders==='true')!==(page<total))throw new EbayError('invalid_order_page');
 const records=orders.map(o=>{if(!seller||(!o.SellerEIASToken&&!o.SellerUserID)||(o.SellerEIASToken&&hash(o.SellerEIASToken)!==seller.eias_sha256)||(o.SellerUserID&&o.SellerUserID.toLowerCase()!==seller.handle.toLowerCase()))throw new EbayError('wrong_order_seller',403);if(!text(o.OrderID,128))throw new EbayError('missing_order_id');const lines=many(o.TransactionArray?.Transaction);if(lines.length>100)throw new EbayError('order_too_large');return {order_id:o.OrderID,extended_order_id:text(o.ExtendedOrderID,128),status:text(o.OrderStatus,80),created_at:date(o.CreatedTime),paid_at:date(o.PaidTime),shipped_at:date(o.ShippedTime),total:money(o.Total),lines:lines.map(t=>{if(!text(t.OrderLineItemID,128)||!/^\d{9,15}$/.test(t.Item?.ItemID||''))throw new EbayError('missing_order_line_identity');return {line_id:t.OrderLineItemID,listing_id:t.Item.ItemID,sku:text(t.Variation?.SKU||t.Item.SKU,128),title:text(t.Item.Title,500),quantity:integer(t.QuantityPurchased),transaction_price:money(t.TransactionPrice)};})};});
 if(new Set(records.map(r=>r.order_id)).size!==records.length)throw new EbayError('duplicate_order_id');
 const deletion_subjects=orders.map(o=>{if(!text(o.EIASToken,512)&&!text(o.BuyerUserID,128))throw new EbayError('buyer_deletion_binding_unavailable',409);return {eias_sha256:text(o.EIASToken,512)?hash(o.EIASToken):null,handle_sha256:text(o.BuyerUserID,128)?hash(o.BuyerUserID):null};});
 return {records,page,total_pages:total,total_entries:count,has_more:page<total,coverage:'created_in_fixed_window',deletion_subjects};
}
export function tradingBody(call,args={}){
 let fields='';
 if(call==='GetUser'){fields='<DetailLevel>ReturnSummary</DetailLevel>';}
 else if(call==='GetMyeBaySelling'){fields=`<ActiveList><Include>true</Include><Pagination><EntriesPerPage>50</EntriesPerPage><PageNumber>${args.page}</PageNumber></Pagination></ActiveList><SoldList><Include>false</Include></SoldList><UnsoldList><Include>false</Include></UnsoldList><ScheduledList><Include>false</Include></ScheduledList><SellingSummary><Include>false</Include></SellingSummary>`;}
 else if(call==='GetOrders'){fields=`<CreateTimeFrom>${escape(args.from)}</CreateTimeFrom><CreateTimeTo>${escape(args.to)}</CreateTimeTo><OrderRole>Seller</OrderRole><OrderStatus>All</OrderStatus><Pagination><EntriesPerPage>50</EntriesPerPage><PageNumber>${args.page}</PageNumber></Pagination>`;}
 else throw new EbayError('unsupported_read',400);
 if(call!=='GetUser'&&(!Number.isSafeInteger(args.page)||args.page<1||args.page>100))throw new EbayError('invalid_page',400);
 return `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">${fields}</${call}Request>`;
}
// eBay's Apache-2.0 SDK uses ECDSA/SHA1 over JSON.stringify(message), not an invented webhook protocol.
export function signatureHeader(value){try{if(typeof value!=='string'||value.length>2048||!/^[A-Za-z0-9+/]+=*$/.test(value))throw Error();const parsed=JSON.parse(Buffer.from(value,'base64').toString('utf8'));if(parsed.alg!=='ecdsa'||parsed.digest!=='SHA1'||!/^[A-Za-z0-9_-]{1,100}$/.test(parsed.kid||'')||typeof parsed.signature!=='string'||! /^[A-Za-z0-9+/]+=*$/.test(parsed.signature)||parsed.signature.length>300)throw Error();return parsed;}catch{throw new EbayError('invalid_signature',412);}}
export function verifyNotification(message,signature,key){
 if(key?.algorithm!=='ECDSA'||key?.digest!=='SHA1'||typeof key.key!=='string'||key.key.length>4096)throw new EbayError('unsupported_public_key',412);
 let publicKey;try{publicKey=createPublicKey(key.key.replace('-----BEGIN PUBLIC KEY-----','-----BEGIN PUBLIC KEY-----\n').replace('-----END PUBLIC KEY-----','\n-----END PUBLIC KEY-----'));}catch{throw new EbayError('unsupported_public_key',412);}
 if(publicKey.asymmetricKeyType!=='ec'||publicKey.asymmetricKeyDetails?.namedCurve!=='prime256v1'||!verify('sha1',Buffer.from(JSON.stringify(message)),publicKey,Buffer.from(signature.signature,'base64')))throw new EbayError('invalid_signature',412);
 const n=message.notification,d=n?.data;
 if(message.metadata?.topic!=='MARKETPLACE_ACCOUNT_DELETION'||message.metadata?.schemaVersion!=='1.0'||!text(n?.notificationId,160)||!date(n?.eventDate)||!text(d?.eiasToken,512)||!text(d?.userId,128)||!text(d?.username,128))throw new EbayError('invalid_deletion_notice',400);
 // Retries may change publishDate/attemptCount. Those are not semantic identity.
 return {event_id:n.notificationId,event_at:date(n.eventDate),subject_eias_sha256:hash(d.eiasToken),subject_user_sha256:hash(d.userId),subject_handle_sha256:hash(d.username)};
}
