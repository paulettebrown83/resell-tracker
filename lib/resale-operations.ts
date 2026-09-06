import { supabase, requireAccess, requireWritableDeployment } from './supabase'

export type ExecutionMode = 'api_automatic' | 'file_automatic' | 'supervised_agent_browser' | 'human_required' | 'unavailable'
export type OperationKind = 'publish' | 'update' | 'delist' | 'import' | 'reconcile_sale' | 'reconcile_cancellation' | 'reconcile_shipping'
export type OperationState = 'blocked' | 'queued' | 'running' | 'uncertain' | 'succeeded' | 'failed' | 'cancelled'
export type AttemptOutcome = 'accepted' | 'verified' | 'rejected' | 'uncertain'
export interface OperationRequest {
  account_id: string
  action: OperationKind
  listing_id?: string | null
  inventory_id?: string | null
  expected_observation_id?: string | null
  expected_item_version?: number | null
  trigger: { kind: 'member_request' | 'source_record' | 'order_event' | 'sale'; id: string }
  requested: Record<string, unknown>
}
export interface OperationEvidenceProposal {
  source_record_ids: string[]
  note: string
}
export interface ResaleOperation {
  id: string; account_id: string; marketplace: string; action: OperationKind; state: OperationState
  execution_mode: ExecutionMode; adapter_key: string | null; adapter_version: string | null
  listing_id: string | null; inventory_id: string | null
  trigger: OperationRequest['trigger'] | null
  required_fields: string[]; missing_fields: string[]
  blockers: Array<{code: string; message: string}>
  deep_link: string | null
  next_step: {key: string; label: string; explanation: string} | null
  checkpoint: {step_key?: string; source_record_ids?: string[]; snapshot_ids?: string[]}
  attempts: number; next_attempt_at: string | null; last_error: string | null
  latest_outcome: AttemptOutcome | null
  verification_id: string | null; verification_observation_id: string | null
  proposal_count: number; created_at: string; updated_at: string
}

/** Member read only. Unknown browser availability never means a platform adapter is unavailable. */
export async function getResaleOperations(accountId?: string): Promise<ResaleOperation[]> {
  await requireAccess()
  const result: ResaleOperation[] = []
  for (let from = 0; ; from += 250) {
    let query = supabase.from('resale_operation_view').select('*').order('created_at', { ascending: false }).order('id').range(from, from + 249)
    if (accountId) query = query.eq('account_id', accountId)
    const { data, error } = await query
    if (error) throw error
    result.push(...data as ResaleOperation[])
    if (data.length < 250) return result
  }
}

/** Keep requestId and input unchanged for retries. Returns the same durable operation ID. */
export async function requestResaleOperation(input: OperationRequest, requestId: string): Promise<string> {
  requireWritableDeployment()
  await requireAccess()
  const { data, error } = await supabase.rpc(input.requested.scope === 'poshmark_private_listing_reference' ? 'resale_request_listing_reference' : input.requested.scope === 'exact_listing_refresh' ? 'resale_request_listing_refresh' : 'resale_request_operation', { p_request_id: requestId, p_payload: input })
  if (error) throw error
  return data as string
}

/** Evidence is a proposal for a trusted check; this call cannot complete a task or change a sale. */
export async function submitResaleOperationEvidence(operationId: string, input: OperationEvidenceProposal, requestId: string): Promise<string> {
  requireWritableDeployment()
  await requireAccess()
  const { data, error } = await supabase.rpc('resale_submit_operation_evidence', {
    p_request_id: requestId, p_operation_id: operationId, p_payload: input,
  })
  if (error) throw error
  return data as string
}
