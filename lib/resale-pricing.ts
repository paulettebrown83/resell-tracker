/** Observed provider settings, never a cost or physical-stock fact. */
export interface ListingPricing {
  listing_id: string; account_id: string; external_listing_id: string | null;
  inventory_id: string | null; draft_version: number;
  pricing_observation_id: string | null; observed_at: string | null;
  pricing_status: 'unknown' | 'observed' | 'stale' | 'conflict' | 'target_changed';
  currency: string | null; asking_minor: number | null;
  mechanism: 'mercari_smart_pricing' | 'poshmark_smart_sell' | 'unknown' | null;
  enabled: boolean | null; minimum_minor: number | null;
}
export interface PricingExpectation {
  pricing_observation_id: string; draft_version: number;
  account_id: string; listing_id: string; external_listing_id: string;
  inventory_id: string | null; policy: 'preserve_platform'; intent: 'set_asking_price';
}
export function capturePricingExpectation(p: ListingPricing): PricingExpectation | null {
  if (!p.pricing_observation_id || !p.external_listing_id || p.pricing_status !== 'observed') return null;
  return { pricing_observation_id:p.pricing_observation_id, draft_version:p.draft_version,
    account_id:p.account_id, listing_id:p.listing_id, external_listing_id:p.external_listing_id,
    inventory_id:p.inventory_id, policy:'preserve_platform', intent:'set_asking_price' };
}
/** Preparation check only. Passing never means a remote writer is available. */
export function pricingConflict(p: ListingPricing | undefined, expected?: PricingExpectation | null, now=Date.now()): string | null {
  if (!p || ['unknown','conflict','target_changed'].includes(p.pricing_status) || !p.pricing_observation_id) return p?.pricing_status==='conflict' ? 'Conflicting price settings need a fresh check.' : p?.pricing_status==='target_changed' ? 'The listing or item link changed. Check its price settings again.' : 'Automatic pricing settings have not been verified.';
  if (p.pricing_status==='stale' || !p.observed_at || !Number.isFinite(Date.parse(p.observed_at)) || Date.parse(p.observed_at)>now+300000 || now-Date.parse(p.observed_at)>86400000) return 'Price settings need a fresh marketplace check.';
  if (expected && (expected.pricing_observation_id!==p.pricing_observation_id || expected.draft_version!==p.draft_version || expected.account_id!==p.account_id || expected.listing_id!==p.listing_id || expected.external_listing_id!==p.external_listing_id || expected.inventory_id!==p.inventory_id)) return 'The prepared request is out of date. Refresh before continuing.';
  if (p.enabled!==false || p.mechanism==='unknown') return 'Automatic pricing or offers are enabled or unverified. A fixed price update is blocked.';
  return null;
}
export function pricingSummary(p: ListingPricing | undefined): string {
  if (!p || !p.mechanism) return 'Automatic price settings not checked';
  if (p.pricing_status==='conflict') return 'Conflicting marketplace price settings';
  if (p.pricing_status==='target_changed') return 'Price settings belong to an earlier listing or item link';
  const name=p.mechanism==='mercari_smart_pricing'?'Smart Pricing':p.mechanism==='poshmark_smart_sell'?'Smart Sell offers':'Automatic pricing';
  return `${name}: ${p.enabled===true?'on':p.enabled===false?'off':'not verified'}`;
}
