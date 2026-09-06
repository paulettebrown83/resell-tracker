import { pricingSummary, pricingConflict, type ListingPricing } from '@/lib/resale-pricing';
export default function ListingPricingState({ pricing, externalListingId }: {pricing?: ListingPricing;externalListingId:string|null}) {
  if (!externalListingId) return null;
  const amount=(minor:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:pricing?.currency||'USD'}).format(minor/100);
  return <section className="wb-listing-pricing" aria-label="Marketplace price settings">
    <strong>{pricingSummary(pricing)}</strong>
    {pricing?.asking_minor!=null && pricing.currency && <p>Observed asking price {amount(pricing.asking_minor)}{pricing.minimum_minor!=null?` · Minimum ${amount(pricing.minimum_minor)}`:''}</p>}
    {pricing?.asking_minor!=null && !pricing.currency && <p>Asking price currency not verified.</p>}
    {pricing?.mechanism==='mercari_smart_pricing' && pricing.enabled===true && pricing.minimum_minor==null && <p>Minimum price not verified.</p>}
    {pricing?.enabled===true && <p>{pricing.mechanism==='mercari_smart_pricing'?'The marketplace controls price reductions.':'The marketplace can send automatic offers.'} A fixed price update is blocked.</p>}
    {pricing?.observed_at && <p>Price settings checked {new Date(pricing.observed_at).toLocaleString()}.</p>}
    {pricingConflict(pricing) && (pricing?.enabled!==true || pricing?.pricing_status!=='observed') && <p>{pricingConflict(pricing)}</p>}
    <p>Remote price updates are not connected. Your shop settings stay unchanged.</p>
  </section>;
}
