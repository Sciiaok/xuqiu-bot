/**
 * QA snippets service.
 *
 * QA snippets are sales-curated "if customer asks X, answer Y" pairs.
 * They are checked first inside lookup_policy.
 */
import { generateEmbedding, translateToEnglish, detectLanguage } from './kb-search.service.js';
import supabase from '../lib/supabase.js';

async function embedQuestions(questions, tenantId) {
  // Use joined questions for the embedding so similar phrasings cluster.
  const joined = (questions || []).filter(Boolean).join(' || ');
  if (!joined) return null;
  const lang = detectLanguage(joined);
  const englishText = lang === 'en' ? joined : await translateToEnglish(joined, tenantId);
  return generateEmbedding(englishText);
}

export async function listQaSnippets({ tenantId, productLineId, includeInactive = false }) {
  let q = supabase
    .from('kb_qa_snippets')
    .select('id, questions, answer, applicable_when, priority, is_active, created_at, updated_at')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .order('updated_at', { ascending: false });
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function createQaSnippet({ tenantId, productLineId, questions, answer, applicableWhen, priority, createdBy }) {
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('questions[] is required');
  if (!answer || !answer.trim()) throw new Error('answer is required');
  const cleanQuestions = questions.map(q => String(q).trim()).filter(Boolean);
  if (cleanQuestions.length === 0) throw new Error('questions[] cannot be all empty');

  const embedding = await embedQuestions(cleanQuestions, tenantId);
  const { data, error } = await supabase
    .from('kb_qa_snippets')
    .insert({
      tenant_id: tenantId,
      product_line_id: productLineId,
      questions: cleanQuestions,
      questions_embedding: embedding,
      answer: answer.trim(),
      applicable_when: applicableWhen || {},
      priority: priority ?? 5,
      created_by: createdBy || null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function updateQaSnippet(snippetId, updates, ctx) {
  // Re-embed if questions changed
  let embedding;
  if (updates.questions) {
    const cleanQuestions = updates.questions.map(q => String(q).trim()).filter(Boolean);
    if (cleanQuestions.length === 0) throw new Error('questions[] cannot be all empty');
    updates.questions = cleanQuestions;
    embedding = await embedQuestions(cleanQuestions, ctx.tenantId);
  }

  const patch = {};
  if (updates.questions) patch.questions = updates.questions;
  if (embedding !== undefined) patch.questions_embedding = embedding;
  if (updates.answer !== undefined) patch.answer = String(updates.answer).trim();
  if (updates.applicableWhen !== undefined) patch.applicable_when = updates.applicableWhen || {};
  if (updates.priority !== undefined) patch.priority = updates.priority;
  if (updates.isActive !== undefined) patch.is_active = updates.isActive;
  patch.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from('kb_qa_snippets')
    .update(patch)
    .eq('id', snippetId)
    .eq('tenant_id', ctx.tenantId)                      // tenant guard
    .eq('product_line_id', ctx.productLineId);
  if (error) throw error;
}

export async function deleteQaSnippet(snippetId, ctx) {
  const { error } = await supabase
    .from('kb_qa_snippets')
    .delete()
    .eq('id', snippetId)
    .eq('tenant_id', ctx.tenantId)
    .eq('product_line_id', ctx.productLineId);
  if (error) throw error;
}
