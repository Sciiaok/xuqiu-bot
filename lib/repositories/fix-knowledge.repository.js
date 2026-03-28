import supabase from '../supabase.js';
import { config } from '../../src/config.js';

const EMBED_TIMEOUT = 10_000;

/**
 * Generate embedding via OpenRouter using a cheap model.
 * Uses the text-embedding endpoint (OpenAI-compatible).
 * Falls back to null if unavailable.
 */
async function embed(text) {
  const apiKey = config.anthropic.apiKey;
  const baseURL = config.aigc.baseURL || 'https://openrouter.ai/api';
  if (!apiKey) return null;

  try {
    const res = await fetch(`${baseURL}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'openai/text-embedding-3-small',
        input: text.slice(0, 2000),
        dimensions: 768,
      }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch {
    return null;
  }
}

/**
 * Search for similar past fixes.
 * Tries vector search first, falls back to text keyword matching.
 * @param {string} errorText - The error message to search for
 * @returns {Promise<Array>} Matching fix records sorted by similarity
 */
export async function searchFixes(errorText) {
  const embedding = await embed(errorText);
  if (embedding) {
    try {
      const { data, error } = await supabase.rpc('search_fix_knowledge', {
        query_embedding: embedding,
        match_threshold: 0.75,
        match_count: 3,
      });
      if (!error && data?.length > 0) return data;
    } catch {}
  }

  // Fallback: text keyword search
  return textSearchFixes(errorText);
}

/**
 * Fallback text search when embeddings are unavailable.
 */
async function textSearchFixes(errorText) {
  const keywords = errorText
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 5);

  if (!keywords.length) return [];

  const { data, error } = await supabase
    .from('fix_knowledge')
    .select('id, error_pattern, error_context, solution, solution_action, solution_type, success_count')
    .or(keywords.map(k => `error_pattern.ilike.%${k}%`).join(','))
    .order('success_count', { ascending: false })
    .limit(3);

  if (error) return [];
  return (data || []).map(d => ({ ...d, similarity: 0.5 }));
}

/**
 * Save a new fix experience to the knowledge base.
 * Deduplicates: if a similar entry exists (vector > 0.9), increments success_count.
 */
export async function saveFix({ errorPattern, errorContext, solution, solutionAction, solutionType = 'auto' }) {
  const embedding = await embed(`${errorPattern} ${errorContext || ''}`);

  // Deduplicate via vector similarity
  if (embedding) {
    try {
      const { data: existing } = await supabase.rpc('search_fix_knowledge', {
        query_embedding: embedding,
        match_threshold: 0.9,
        match_count: 1,
      });
      if (existing?.length > 0) {
        await supabase
          .from('fix_knowledge')
          .update({
            success_count: existing[0].success_count + 1,
            last_used_at: new Date().toISOString(),
          })
          .eq('id', existing[0].id);
        return { action: 'incremented', id: existing[0].id };
      }
    } catch {}
  }

  const { data, error } = await supabase
    .from('fix_knowledge')
    .insert({
      error_pattern: errorPattern,
      error_context: errorContext,
      solution,
      solution_action: solutionAction,
      solution_type: solutionType,
      embedding,
    })
    .select('id')
    .single();

  if (error) {
    console.warn('[fix-knowledge] Save failed:', error.message);
    return { action: 'failed', error: error.message };
  }
  return { action: 'created', id: data.id };
}
