import type { ResaleAttention, ResaleSourceRecord } from './resale-contract';
import type { ResaleOperation } from './resale-operations';

const reasons: Record<string, string> = {
  sender_authentication: 'The sender’s authentication could not be confirmed. Do not treat this email as proof of a sale.',
  ambiguous_subject: 'The email has conflicting subject information, so its notification type could not be confirmed.',
  mailbox_account_mismatch: 'The expected account greeting was not confirmed. A missing or different greeting does not establish that this message belongs to another account; its format and account still need checking.',
  unrecognized_template: 'This email does not match a supported Vinted sale or shipping-label format. Its meaning needs a manual check.',
  unsupported_body: 'The email body could not be read safely in a supported format. Check the original message.',
};
const headings: Record<string, string> = {
  sale_notification: 'Review sale notice',
  shipping_notification: 'Review shipping-label notice',
  cancellation_notification: 'Review cancellation notice',
};
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function receivedTime(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}
export interface GmailOperationContext {
  heading: string;
  titles: string[];
  additionalTitles: number;
  receivedAt: string | null;
  reason: string;
  legacyComparison: boolean;
}
/** Presentation only: exact saved source/account binding; never infer an item match or mutate evidence. */
export function gmailOperationContext(
  operation: ResaleOperation,
  sources: ResaleSourceRecord[],
  reviews: ResaleAttention[],
): GmailOperationContext | null {
  if (operation.adapter_key !== 'vinted-gmail' || operation.marketplace !== 'vinted'
    || operation.trigger?.kind !== 'source_record') return null;
  const source = sources.find(row => row.id === operation.trigger!.id && row.account_id === operation.account_id && row.source_kind === 'email');
  const unavailable: GmailOperationContext = {
    heading: 'Review saved Vinted email', titles: [], additionalTitles: 0, receivedAt: null,
    reason: 'The saved email details are unavailable in this view. Refresh the source records before deciding what this notice means.',
    legacyComparison: false,
  };
  if (!source) return unavailable;
  // Reused historical sources are immutable. Show the new parser facts only through their exact linked review.
  const linkedReviews = reviews.filter(row => row.evidence.operation_id === operation.id
    && row.evidence.source_record_id === source.id && row.evidence.parser_version === 'vinted-gmail-v1');
  const review = linkedReviews.length === 1 ? linkedReviews[0] : null;
  const facts = review ? record(review.evidence.new_parser_facts)
    : source.normalized.parser_version === 'vinted-gmail-v1' ? source.normalized : null;
  if (!facts || linkedReviews.length > 1) return {
    ...unavailable,
    reason: 'The saved historical email and its parser details need comparison before this notice can be described reliably.',
    legacyComparison: true,
  };
  const recognized = facts.parser_status === 'recognized' && facts.authentication_pass === true;
  // A linked legacy review has no notification_kind. The immutable operation action supplies notice kind only after recognition.
  const kind = source.normalized.parser_version === 'vinted-gmail-v1'
    ? source.normalized.notification_kind
    : ({reconcile_sale: 'sale_notification', reconcile_shipping: 'shipping_notification', reconcile_cancellation: 'cancellation_notification'} as Record<string, string>)[operation.action];
  const knownKind = recognized && typeof kind === 'string' && Object.hasOwn(headings, kind);
  const titles = knownKind && Array.isArray(facts.product_titles)
    ? [...new Set(facts.product_titles.filter((value): value is string => typeof value === 'string'
      && value.trim().length > 0 && value.length <= 300
      && !/[\r\n\u0000-\u001f<>]|https?:\/\/|\S+@\S+\.\S+/i.test(value)).map(value => value.trim()))] : [];
  return {
    heading: knownKind ? headings[kind as string] : 'Review unrecognized Vinted email',
    titles: titles.slice(0, 3), additionalTitles: Math.max(0, titles.length - 3),
    receivedAt: receivedTime(source.raw_business.received_at)
      || (source.normalized.parser_version === 'vinted-gmail-v1' ? receivedTime(source.source_observed_at) : null),
    reason: knownKind
      ? 'Check the exact shop transaction and physical item. This email alone does not verify a sale, shipment or stock change.'
      : typeof facts.quarantine_reason === 'string' && Object.hasOwn(reasons, facts.quarantine_reason)
        ? reasons[facts.quarantine_reason]
        : 'The parser could not establish what this email means. Check the original message before using it as evidence.',
    legacyComparison: review?.evidence.legacy_source_reused === true,
  };
}

export type GmailActivityEntry = { key: string; operations: ResaleOperation[]; feedId: string | null; accountId: string };

/** Group only untouched source-format checks. This changes presentation, never task state or trust. */
export function groupGmailActivity(
  operations: ResaleOperation[], sources: ResaleSourceRecord[], reviews: ResaleAttention[],
): GmailActivityEntry[] {
  const entries: GmailActivityEntry[] = [];
  const groups = new Map<string, GmailActivityEntry>();
  for (const operation of operations) {
    let feedId: string | null = null;
    if (operation.adapter_key === 'vinted-gmail' && operation.marketplace === 'vinted'
      && operation.action === 'import' && operation.state === 'blocked'
      && operation.trigger?.kind === 'source_record' && !operation.inventory_id && !operation.listing_id
      && operation.attempts === 0 && operation.proposal_count === 0 && !operation.last_error
      && !operation.latest_outcome && !operation.verification_id && !operation.verification_observation_id
      && operation.blockers.length === 1 && operation.blockers[0].code === 'source_conflict') {
      const source = sources.find(row => row.id === operation.trigger!.id
        && row.account_id === operation.account_id && row.source_kind === 'email');
      const linked = source ? reviews.filter(row => row.evidence.operation_id === operation.id
        && row.evidence.source_record_id === source.id && row.evidence.parser_version === 'vinted-gmail-v1') : [];
      const review = linked.length === 1 ? linked[0] : null;
      const facts = review ? record(review.evidence.new_parser_facts) : null;
      const id = review?.evidence.feed_id;
      const message = source?.external_identifiers.gmail_message_id;
      if (review?.state === 'open' && !review.inventory_id && !review.listing_id
        && typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        && typeof message === 'string' && /^[0-9a-f]{1,32}$/i.test(message)
        && review.evidence.gmail_message_id === message && review.evidence.canonical_effect === 'none'
        && facts?.parser_status === 'quarantined' && facts.authentication_pass === true
        && ['mailbox_account_mismatch', 'unrecognized_template'].includes(String(facts.quarantine_reason))
        && !['sale_notification', 'shipping_notification', 'cancellation_notification'].includes(String(source?.normalized.notification_kind))) {
        feedId = id;
      }
    }
    if (!feedId) {
      entries.push({key: operation.id, operations: [operation], feedId: null, accountId: operation.account_id});
      continue;
    }
    const key = `gmail:${operation.account_id}:${feedId}`;
    const existing = groups.get(key);
    if (existing) existing.operations.push(operation);
    else {
      const entry = {key, operations: [operation], feedId, accountId: operation.account_id};
      groups.set(key, entry);
      entries.push(entry);
    }
  }
  return entries;
}
