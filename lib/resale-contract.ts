/** Resale workbench v1. IDs are opaque strings; null means unknown, never zero. */
export type ListingStatus = 'unknown' | 'draft' | 'active' | 'reserved' | 'sold' | 'ended' | 'removed';
export type ActionStatus = 'blocked' | 'queued' | 'running' | 'uncertain' | 'succeeded' | 'failed' | 'cancelled';
export type Provenance = 'manual' | 'official_api' | 'export' | 'browser';
export interface ResaleItemDetails {
  inventory_id: string; sku: string | null; description: string | null; brand: string | null;
  category: string | null; condition: string | null; size: string | null; color: string | null;
  material: string | null; measurements: Record<string, { value: number; unit: string }>;
  weight_grams: number | null; location: string | null; attributes: Record<string, unknown>;
  workflow: 'draft' | 'needs_details' | 'ready' | 'archived'; version: number; updated_at: string;
}
export interface ResaleAccount {
  id: string; marketplace: string; account_alias: string; external_account_id: string | null;
  username: string | null; profile_url: string | null;
  login_method: 'unknown' | 'password' | 'google' | 'apple' | 'email_link' | 'other';
  connection_status: 'unverified' | 'manual' | 'connected' | 'expired' | 'blocked';
  capabilities: Record<string, 'unknown' | 'manual' | 'supported' | 'unavailable'>;
  verified_at: string | null;
}
export interface ResaleListing {
  id: string; account_id: string; external_listing_id: string | null; external_identifiers: Record<string, unknown>; inventory_id: string | null;
  match_status: 'unmatched' | 'proposed' | 'confirmed' | 'rejected'; title: string | null;
  listing_url: string | null; desired_fields: Record<string, unknown>;
  asking_price: number | null; currency: string | null;
  observed_status: ListingStatus; observed_at: string | null; observation_id: string | null;
}
export interface ResaleSnapshot {
  id: string; account_id: string; source: Provenance; source_ref: string; observed_at: string;
  scope: string; coverage: 'unknown' | 'partial' | 'complete'; cursor: string | null;
  record_count: number | null; captured_at: string;
}
export interface ResaleMedia {
  id: string; inventory_id: string; original_id: string | null; kind: 'original' | 'thumbnail' | 'marketplace';
  bucket: string; object_key: string; mime_type: string; byte_size: number | null;
  sha256: string | null; width: number | null; height: number | null; position: number;
  state: 'pending' | 'ready' | 'failed' | 'quarantined'; created_at: string;
}
/** URLs are short-lived responses from the authorized media runtime, not persisted public bucket URLs. */
export interface ResaleMediaPreview extends ResaleMedia { url: string | null; expires_at: string | null }
export interface ResaleAttention {
  id: string; inventory_id: string | null; listing_id: string | null;
  reason: string; state: 'open' | 'resolved' | 'dismissed'; evidence: Record<string, unknown>; created_at: string;
}
export interface ResaleAction {
  id: string; listing_id: string; sale_id: string | null; action: 'publish' | 'update' | 'delist';
  state: ActionStatus; idempotency_key: string; reason: string;
  attempts: number; next_attempt_at: string | null; last_error: string | null;
  verification_observation_id: string | null; created_at: string;
}
export type ResaleItemInput = Partial<Omit<ResaleItemDetails, 'inventory_id' | 'version' | 'updated_at'>> & {
  id?: string; version?: number; item_name: string; item_cost: number | null; date_added?: string | null;
};

/** Immutable imported business evidence. Missing order IDs or event times remain missing. */
export interface ResaleSourceRecord {
  id: string; snapshot_id: string; account_id: string; record_key: string; row_index: number | null;
  source_kind: 'csv' | 'browser' | 'email' | 'official_api' | 'webhook' | 'manual';
  source_file_sha256: string | null; source_row_sha256: string | null;
  raw_business: Record<string, unknown>; normalized: Record<string, unknown>;
  external_identifiers: Record<string, unknown>;
  event_precision: 'unknown' | 'date' | 'instant'; event_date: string | null;
  event_time: string | null; event_timezone: string | null;
  source_observed_at: string | null; captured_at: string;
  record_status: 'accepted' | 'needs_review' | 'quarantined'; review_reason: string | null;
  supersedes_record_id: string | null; created_at: string;
}
