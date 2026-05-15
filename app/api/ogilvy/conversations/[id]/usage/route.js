import { getTenantContext } from '../../../../../../lib/tenant-context.js';
import { getSession } from '../../../../../../lib/repositories/ogilvy.repository.js';
import { getSupabaseAdmin } from '../../../../../../lib/supabase-admin.js';

// Context window for the models ogilvy uses (Sonnet 4.6 / Haiku 4.5 both 200K).
// Hard-coded rather than queried per-call — it's a model property, not a per-row fact.
const CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * GET /api/ogilvy/conversations/[id]/usage
 *
 * Returns token / cost aggregates for a single ogilvy session — the data
 * source behind the UsageBadge in the chat header (Claude Code statusline 风格).
 *
 * Shape:
 *   {
 *     totals: { prompt, completion, cache_read, cache_create, total_input, cost_usd },
 *     by_call_site: { [callSite]: { prompt, completion, ... } },
 *     by_model:     { [model]:    { prompt, completion, ... } },
 *     context_window_tokens: 200000,
 *     turn_count: <number of LLM calls in this session>,
 *   }
 *
 * Notes:
 * - "total_input" sums prompt + cache_read + cache_create — this is what
 *   actually occupies the context window. Display this against context_window.
 * - We sum on the API side (no client-side aggregation) so the badge can
 *   render the moment data arrives.
 * - Empty-session response: zeroed-out totals + empty maps + turn_count: 0.
 */
export async function GET(_request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;

  // Tenant isolation: session must belong to caller's tenant.
  const session = await getSession(id);
  if (!session || session.tenant_id !== ctx.tenantId) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('llm_usage_logs')
      .select('call_site, model, prompt_tokens, completion_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd')
      .eq('session_id', id);

    if (error) throw new Error(error.message);

    const totals = {
      prompt: 0, completion: 0, cache_read: 0, cache_create: 0,
      total_input: 0, cost_usd: 0,
    };
    const byCallSite = {};
    const byModel = {};

    for (const row of data || []) {
      const prompt = row.prompt_tokens || 0;
      const completion = row.completion_tokens || 0;
      const cacheRead = row.cache_read_input_tokens || 0;
      const cacheCreate = row.cache_creation_input_tokens || 0;
      const cost = Number(row.cost_usd) || 0;

      totals.prompt += prompt;
      totals.completion += completion;
      totals.cache_read += cacheRead;
      totals.cache_create += cacheCreate;
      totals.total_input += prompt + cacheRead + cacheCreate;
      totals.cost_usd += cost;

      const cs = row.call_site || 'unknown';
      if (!byCallSite[cs]) byCallSite[cs] = { prompt: 0, completion: 0, cache_read: 0, cache_create: 0, cost_usd: 0, count: 0 };
      byCallSite[cs].prompt += prompt;
      byCallSite[cs].completion += completion;
      byCallSite[cs].cache_read += cacheRead;
      byCallSite[cs].cache_create += cacheCreate;
      byCallSite[cs].cost_usd += cost;
      byCallSite[cs].count += 1;

      const m = row.model || 'unknown';
      if (!byModel[m]) byModel[m] = { prompt: 0, completion: 0, cache_read: 0, cache_create: 0, cost_usd: 0, count: 0 };
      byModel[m].prompt += prompt;
      byModel[m].completion += completion;
      byModel[m].cache_read += cacheRead;
      byModel[m].cache_create += cacheCreate;
      byModel[m].cost_usd += cost;
      byModel[m].count += 1;
    }

    return Response.json({
      totals,
      by_call_site: byCallSite,
      by_model: byModel,
      context_window_tokens: CONTEXT_WINDOW_TOKENS,
      turn_count: (data || []).length,
    });
  } catch (err) {
    console.error('[ogilvy/conversations/[id]/usage GET]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
