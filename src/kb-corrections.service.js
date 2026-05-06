/**
 * Corrections service.
 *
 * Captures "sales rewrote medici's reply" events and turns them into
 * suggested QA snippets (default action). User can then one-click adopt.
 */
import supabase from '../lib/supabase.js';
import { createQaSnippet } from './kb-qa-snippets.service.js';

export async function recordCorrection(ctx, input) {
  const { tenantId, productLineId } = ctx;
  if (!tenantId || !productLineId) throw new Error('recordCorrection: tenantId+productLineId required');

  const insert = {
    tenant_id: tenantId,
    product_line_id: productLineId,
    conversation_id: input.conversationId,
    message_id: input.messageId || null,
    customer_question: input.customerQuestion || null,
    medici_original_answer: input.mediciOriginalAnswer,
    human_corrected_answer: input.humanCorrectedAnswer,
    diff_summary: input.diffSummary || null,
    suggested_kb_action: input.suggestedKbAction || 'add_qa',
    suggested_payload: input.suggestedPayload || null,
    created_by: input.createdBy || null,
  };
  const { data, error } = await supabase
    .from('kb_corrections')
    .insert(insert)
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function listCorrections({ tenantId, productLineId, status = 'pending', limit = 100 }) {
  const { data, error } = await supabase
    .from('kb_corrections')
    .select(`
      id, conversation_id, message_id, customer_question,
      medici_original_answer, human_corrected_answer, diff_summary,
      suggested_kb_action, suggested_payload, status, adopted_target_id,
      created_by, created_at, resolved_by, resolved_at
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
 * One-click adopt: turn the correction into a new QA snippet.
 * Customer's question becomes the QA question; corrected answer becomes the
 * QA answer. If `payload_overrides` is supplied, use them instead.
 */
export async function adoptCorrection(correctionId, ctx, { resolvedBy, overrides } = {}) {
  const { tenantId, productLineId } = ctx;
  const { data: row, error: fetchErr } = await supabase
    .from('kb_corrections')
    .select('*')
    .eq('id', correctionId)
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('status', 'pending')
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!row) throw new Error('correction not found or already resolved');

  if (row.suggested_kb_action !== 'add_qa') {
    throw new Error(`adoptCorrection only supports add_qa for now (got: ${row.suggested_kb_action})`);
  }

  const questions = overrides?.questions || (row.customer_question ? [row.customer_question] : []);
  const answer = overrides?.answer || row.human_corrected_answer;
  if (!questions.length || !answer) {
    throw new Error('cannot adopt: missing question or answer');
  }

  const qaId = await createQaSnippet({
    tenantId,
    productLineId,
    questions,
    answer,
    applicableWhen: overrides?.applicable_when || {},
    priority: overrides?.priority ?? 7,    // sales-curated > LLM-extracted
    createdBy: resolvedBy,
  });

  await supabase
    .from('kb_corrections')
    .update({
      status: 'adopted',
      adopted_target_id: qaId,
      resolved_by: resolvedBy || null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', correctionId);

  return qaId;
}

export async function rejectCorrection(correctionId, ctx, { resolvedBy } = {}) {
  const { tenantId, productLineId } = ctx;
  const { error } = await supabase
    .from('kb_corrections')
    .update({
      status: 'rejected',
      resolved_by: resolvedBy || null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', correctionId)
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('status', 'pending');
  if (error) throw error;
}
