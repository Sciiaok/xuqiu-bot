/**
 * Pending review queue service.
 *
 * Conflict / low-confidence extractions land here instead of going straight
 * into kb_products / kb_shipping_routes / kb_knowledge_points / kb_assets.
 * A human approves, rejects, or merges them via the admin UI.
 */
import supabase from '../lib/supabase.js';

/**
 * Enqueue a row for review.
 *
 * @param {Object} ctx               { tenantId, productLineId }
 * @param {Object} input
 * @param {string} input.targetTable
 * @param {Object} input.targetPayload     The row that wants to be inserted
 * @param {string} input.reason            'conflict' | 'low_confidence' | 'expired_replacement' | 'asset_missing_tags'
 * @param {string} [input.conflictWith]    UUID of the existing row being challenged
 * @param {string} [input.sourceDocId]
 * @param {number} [input.extractedConfidence]   0–1
 */
export async function enqueueForReview(ctx, input) {
  const { tenantId, productLineId } = ctx;
  if (!tenantId || !productLineId) throw new Error('enqueueForReview: tenantId+productLineId required');
  const { error, data } = await supabase
    .from('kb_pending_review')
    .insert({
      tenant_id: tenantId,
      product_line_id: productLineId,
      target_table: input.targetTable,
      target_payload: input.targetPayload,
      reason: input.reason,
      conflict_with: input.conflictWith || null,
      source_doc_id: input.sourceDocId || null,
      extracted_confidence: input.extractedConfidence ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function listPending({ tenantId, productLineId, status = 'pending', limit = 100 }) {
  const { data, error } = await supabase
    .from('kb_pending_review')
    .select(`
      id, target_table, target_payload, reason, conflict_with,
      source_doc_id, extracted_confidence, status, resolved_by,
      resolved_at, resolved_note, resolved_target_id, created_at
    `)
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

/**
 * Approve a pending row → write target_payload into target_table.
 * Returns the new row id (or the conflicted row id if reason='expired_replacement').
 */
export async function approveReview(reviewId, ctx, { resolvedBy } = {}) {
  const { tenantId, productLineId } = ctx;
  const { data: row, error: fetchErr } = await supabase
    .from('kb_pending_review')
    .select('*')
    .eq('id', reviewId)
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('status', 'pending')
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!row) throw new Error('pending review row not found or already resolved');

  // Insert into target table — payload is responsible for being valid for that table
  const insertPayload = {
    ...row.target_payload,
    tenant_id: tenantId,
    product_line_id: productLineId,
    confidence: 'verified',                  // human-approved → verified
  };

  const { data: inserted, error: insertErr } = await supabase
    .from(row.target_table)
    .insert(insertPayload)
    .select('id')
    .single();
  if (insertErr) throw insertErr;

  // If this approval supersedes a conflicting row, deactivate it (kb_products
  // has is_active; kb_knowledge_points has status; everything else just stays).
  if (row.conflict_with) {
    if (row.target_table === 'kb_products') {
      await supabase.from('kb_products').update({ is_active: false }).eq('id', row.conflict_with);
    } else if (row.target_table === 'kb_knowledge_points') {
      await supabase.from('kb_knowledge_points').update({ status: 'superseded', superseded_by: inserted.id }).eq('id', row.conflict_with);
    } else if (row.target_table === 'kb_shipping_routes') {
      await supabase.from('kb_shipping_routes').update({ expiry_date: new Date().toISOString().split('T')[0] }).eq('id', row.conflict_with);
    }
  }

  await supabase
    .from('kb_pending_review')
    .update({
      status: 'approved',
      resolved_by: resolvedBy || null,
      resolved_at: new Date().toISOString(),
      resolved_target_id: inserted.id,
    })
    .eq('id', reviewId);

  return inserted.id;
}

export async function rejectReview(reviewId, ctx, { resolvedBy, note } = {}) {
  const { tenantId, productLineId } = ctx;
  const { error } = await supabase
    .from('kb_pending_review')
    .update({
      status: 'rejected',
      resolved_by: resolvedBy || null,
      resolved_at: new Date().toISOString(),
      resolved_note: note || null,
    })
    .eq('id', reviewId)
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('status', 'pending');
  if (error) throw error;
}
