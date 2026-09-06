/** Sourced guidance, not a publisher or a complete marketplace eligibility validator. */
export const LISTING_RULES_VERSION = '2026-09-06.1'
export type Marketplace = 'ebay' | 'mercari' | 'poshmark' | 'depop' | 'vinted'
export type DraftChannel = 'consumer' | 'bulk' | 'api'
export interface DraftFields {
  title?: string | null; description?: string | null; price?: number | null; currency?: string | null
  category_id?: string | null; category_label?: string | null; condition?: string | null; size?: string | null
  media_ids?: string[]; attributes?: Record<string, string | string[]>
  shipping?: { method?: string; packed_weight_grams?: number | null; notes?: string }
}
export interface WritingPreferences { style?: 'plain' | 'factual_bullets' | 'style_led'; avoid_emojis?: boolean; hashtag_target?: number }
export interface RuleSource { id: string; kind: 'official_documentation' | 'account_editor' | 'account_template'; reference: string; retrieved_at: string }
export interface PlatformRule {
  id: string; field: 'title' | 'description' | 'media_ids' | 'hashtags'; maximum: number
  source: RuleSource; channels: DraftChannel[]; market: 'US'; confidence: 'documented' | 'observed'
  note: string
}
export interface PlatformGuidance { marketplace: Marketplace; version: string; rules: PlatformRule[]; preparation: string[]; unknowns: string[] }
const date='2026-09-06'
const source=(id:string,kind:RuleSource['kind'],reference:string):RuleSource=>({id,kind,reference,retrieved_at:date})
const rule=(id:string,field:PlatformRule['field'],maximum:number,src:RuleSource,channels:DraftChannel[],note:string):PlatformRule=>({id,field,maximum,source:src,channels,market:'US',confidence:src.kind==='official_documentation'?'documented':'observed',note})
const ebay=source('ebay-title','official_documentation','https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/listing-title.html')
const depop=source('depop-api','official_documentation','https://partnerapi.depop.com/api-docs/reference/')
const mercari=source('mercari-editor-20260906','account_editor','marketplaces/mercari/evidence/editor.json')
const posh=source('poshmark-bulk-20260906','account_template','marketplaces/poshmark/evidence/bulk-template.json')
const depopEditor=source('depop-editor-20260906','account_editor','marketplaces/depop/listing-fields.json')
const vinted=source('vinted-editor-20260906','account_editor','marketplaces/vinted/capabilities.json')
export const PLATFORM_GUIDANCE: Record<Marketplace,PlatformGuidance> = {
 ebay:{marketplace:'ebay',version:LISTING_RULES_VERSION,rules:[rule('ebay-title-max','title',80,ebay,['consumer','api'],'Official title limit.')],preparation:['Use factual item details and measurements.','Resolve category aspects, condition and shipping/business policies for the actual category/account.'],unknowns:['Category-specific required aspects and shipping eligibility have not been validated for this item.','Current image limits depend on the selected API/category; do not assume a universal limit.']},
 mercari:{marketplace:'mercari',version:LISTING_RULES_VERSION,rules:[rule('mercari-title','title',80,mercari,['consumer'],'Observed account editor, not a universal API contract.'),rule('mercari-description','description',1000,mercari,['consumer'],'Observed account editor.'),rule('mercari-photos','media_ids',12,mercari,['consumer'],'Observed account editor.')],preparation:['Keep copy factual and measurements clear.','Confirm category/department, packed weight and actual shipping option.'],unknowns:['Current category and label eligibility must be checked in the account editor.']},
 poshmark:{marketplace:'poshmark',version:LISTING_RULES_VERSION,rules:[rule('poshmark-title','title',80,posh,['bulk'],'Downloaded account bulk template only.'),rule('poshmark-description','description',1500,posh,['bulk'],'Bulk template permits newlines but disallows bullets/formatting.'),rule('poshmark-photos','media_ids',16,posh,['bulk'],'Bulk template only.')],preparation:['Lead with brand/item, relevant style, measurements and condition.','Bulk output uses plain text; verify the current label and packed parcel restrictions.'],unknowns:['Bulk constraints are not automatically consumer-editor constraints.','Current category/dimension shipping restrictions require account verification.']},
 depop:{marketplace:'depop',version:LISTING_RULES_VERSION,rules:[rule('depop-description','description',1000,depop,['api'],'Partner API constraint; consumer counter must be checked separately.'),rule('depop-hashtags','hashtags',5,depop,['api'],'Maximum five; exactly five is a writing preference, not a requirement.'),rule('depop-photos','media_ids',8,depopEditor,['consumer'],'Observed account editor.')],preparation:['Use one clear description; the observed editor has no separate title.','State actual item facts, measurements, condition and only relevant style terms.','Resolve category/size taxonomy and exactly the applicable shipping choice before publication.'],unknowns:['Consumer description/hashtag limits need current editor verification.','API availability is account-specific; a prepared draft does not imply approved API access.']},
 vinted:{marketplace:'vinted',version:LISTING_RULES_VERSION,rules:[rule('vinted-photos','media_ids',20,vinted,['consumer'],'Observed account evidence; US consumer character limits are unknown.')],preparation:['Use a plain descriptive title and accurate condition/size/package details.','For sets, verify bundle labeling, total price and no separately listed components.'],unknowns:['US consumer title and description character limits remain unverified.','Account/item commercial eligibility and package restrictions require verification.']},
}
/** Imported writing preferences, explicitly not platform requirements or verified direct instructions. */
export const IMPORTED_WRITING_DEFAULTS = {source:'imported_claude_context',verified_direct_instruction:false,version:LISTING_RULES_VERSION,preferences:{avoid_emojis:true} satisfies WritingPreferences}
export function resolveDraftFields(fields:DraftFields,overrides:Partial<DraftFields>={}):DraftFields {
  // Overrides replace whole fields. Explicit null clears a value; undefined preserves it.
  return {...fields,...Object.fromEntries(Object.entries(overrides).filter(([,value])=>value!==undefined))}
}
export interface DraftIssue { code:string; severity:'error'|'warning'|'unknown'; field?:string; message:string; source?:RuleSource }
export function validateListingDraft(marketplace:Marketplace,fields:DraftFields,context:{channel:DraftChannel;market:string;today:string},preferences:WritingPreferences={}):{issues:DraftIssue[];draft_save_allowed:boolean;publish_ready:false;rules_version:string} {
 const guidance=PLATFORM_GUIDANCE[marketplace],issues:DraftIssue[]=[]
 if(fields.price!=null&&(!Number.isFinite(fields.price)||fields.price<0||fields.price>=100000000||Math.abs(fields.price*100-Math.round(fields.price*100))>0.000001))issues.push({code:'invalid_price',severity:'error',field:'price',message:'A proposed price must be a nonnegative amount with at most two decimal places.'})
 if(fields.currency!=null&&!/^[A-Z]{3}$/.test(fields.currency))issues.push({code:'invalid_currency',severity:'error',field:'currency',message:'Use a three-letter uppercase currency code, or leave it unknown.'})
 for(const r of guidance.rules){
  if(r.market!==context.market||!r.channels.includes(context.channel))continue
  const age=(Date.parse(context.today)-Date.parse(r.source.retrieved_at))/86400000
  if(!Number.isFinite(age)||age<0||age>30){issues.push({code:'rule_needs_refresh',severity:'unknown',field:r.field,message:'This dated guidance needs verification before relying on its limit.',source:r.source});continue}
  const count=r.field==='media_ids'?fields.media_ids?.length:r.field==='hashtags'?(fields.description?.match(/#[\p{L}\p{N}_]+/gu)||[]).length:typeof fields[r.field]==='string'?Array.from(fields[r.field]!).length:undefined
  if(count!==undefined&&count>r.maximum)issues.push({code:'exceeds_sourced_limit',severity:'warning',field:r.field,message:`${r.field}: ${count} exceeds the ${r.maximum} limit for this source and channel. ${r.note}`,source:r.source})
 }
 for(const field of ['description','condition'] as const)if(!fields[field]?.trim())issues.push({code:'missing_item_fact',severity:'unknown',field,message:`${field} is not recorded yet.`})
 if(fields.price==null)issues.push({code:'price_unknown',severity:'unknown',field:'price',message:'No proposed price is recorded.'})
 if(!fields.category_id)issues.push({code:'category_unverified',severity:'unknown',field:'category_id',message:'Confirm the actual marketplace category; a label is not a taxonomy ID.'})
 if(!fields.shipping?.method||fields.shipping.method==='unknown')issues.push({code:'shipping_unverified',severity:'unknown',field:'shipping',message:'Shipping remains unverified; no free shipping or dispatch promise is assumed.'})
 if(!fields.media_ids?.length)issues.push({code:'photos_missing',severity:'unknown',field:'media_ids',message:'Choose verified item photos; private originals are not public publishing URLs.'})
 if(marketplace==='depop'&&fields.title?.trim())issues.push({code:'no_separate_title',severity:'warning',field:'title',message:'The observed Depop editor uses one description, not a separate title.'})
 if(marketplace==='poshmark'&&context.channel==='bulk'&&/^\s*[-*•]\s+/m.test(fields.description||''))issues.push({code:'bulk_plain_text',severity:'warning',field:'description',message:'The account bulk template disallows bullets and formatting.',source:posh})
 if(preferences.avoid_emojis&&/\p{Extended_Pictographic}/u.test((fields.title||'')+(fields.description||'')))issues.push({code:'writing_preference',severity:'warning',message:'This draft differs from the selected no-emoji writing preference.'})
 for(const message of guidance.unknowns)issues.push({code:'platform_verification_needed',severity:'unknown',message})
 return {issues,draft_save_allowed:!issues.some(issue=>issue.severity==='error'),publish_ready:false,rules_version:guidance.version}
}
