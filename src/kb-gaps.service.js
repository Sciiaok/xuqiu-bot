/**
 * KB Gaps recorder.
 *
 * Called by medici's tool dispatcher whenever a KB tool returns a "no" result
 * (not_found / needs_human / unknown). Aggregates by question_signature so the
 * same missed question logs once with frequency++.
 */
import supabase from '../lib/supabase.js';

function normalize(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Record a knowledge gap. Idempotent on (tenant, product_line, question_signature):
 * subsequent calls bump occurrence_count and append to question_examples /
 * example_message_ids.
 *
 * @param {Object} ctx
 * @param {string} ctx.tenantId
 * @param {string} ctx.productLineId
 * @param {string} [ctx.agentId]                Required by old NOT NULL column
 * @param {Object} input
 * @param {string} input.question               Customer's question (raw)
 * @param {string} input.toolName               'lookup_product' | 'quote_price' | ...
 * @param {string} input.gapType                'no_result' | 'low_confidence' | 'outdated' | 'conflicting'
 * @param {string} [input.layer]
 * @param {string} [input.messageId]
 */
export async function recordGap(ctx, { question, toolName, gapType, layer, messageId }) {
  const { tenantId, productLineId, agentId } = ctx || {};
  if (!tenantId || !productLineId || !question) return null;

  const signature = normalize(question);
  if (!signature) return null;

  // Try update first (the unique index ensures only one row per signature).
  const { data: existing } = await supabase
    .from('kb_knowledge_gaps')
    .select('id, occurrence_count, question_examples, example_message_ids')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('question_signature', signature)
    .maybeSingle();

  if (existing) {
    const examples = Array.from(new Set([...(existing.question_examples || []), question])).slice(0, 10);
    const msgIds = messageId
      ? Array.from(new Set([...(existing.example_message_ids || []), messageId])).slice(0, 20)
      : existing.example_message_ids;
    await supabase
      .from('kb_knowledge_gaps')
      .update({
        occurrence_count: (existing.occurrence_count || 1) + 1,
        last_occurred_at: new Date().toISOString(),
        question_examples: examples,
        example_message_ids: msgIds,
        tool_name: toolName,
      })
      .eq('id', existing.id);
    return existing.id;
  }

  // First occurrence
  const insert = {
    tenant_id: tenantId,
    product_line_id: productLineId,
    query: question,
    layer: layer || null,
    gap_type: gapType,
    status: 'open',
    occurrence_count: 1,
    question_signature: signature,
    question_examples: [question],
    example_message_ids: messageId ? [messageId] : null,
    tool_name: toolName,
  };
  // Old NOT NULL column — keep filling for safety
  if (agentId) insert.agent_id = agentId;

  const { data, error } = await supabase
    .from('kb_knowledge_gaps')
    .insert(insert)
    .select('id')
    .single();

  if (error) {
    // Don't blow up the conversation if gap-recording fails
    console.warn('[kb-gaps] insert failed:', error.message);
    return null;
  }
  return data.id;
}
