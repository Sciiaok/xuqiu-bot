import { getTenantContext } from '../../../../../../lib/tenant-context.js';
import { getSession } from '../../../../../../lib/repositories/ogilvy.repository.js';
import { getSupabaseAdmin } from '../../../../../../lib/supabase-admin.js';

// Context window for ogilvy's main turn — Sonnet 4.6 is 1M tokens
// (https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-5).
// 工具调用 (web_search / read_webpage) 走 Haiku 4.5 (200K)，但它们是 short
// single-turn synthesis (prompt < 20K)，不可能接近上限，无需为它单独 surface
// context 用量。主对话 (ogilvy.turn) 锁定 Sonnet 后，UsageBadge 显示的
// "当前上下文" 就是 latest ogilvy.turn 的 total_input 对 1M 的占比。
const CONTEXT_WINDOW_TOKENS = 1_000_000;

/**
 * GET /api/ogilvy/conversations/[id]/usage
 *
 * Returns token / cost aggregates for a single ogilvy session — the data
 * source behind the UsageBadge in the chat header (Claude Code statusline 风格).
 *
 * Shape:
 *   {
 *     totals:  { prompt, completion, cache_read, cache_create, total_input, cost_usd },
 *     latest:  { prompt, cache_read, cache_create, total_input, completion, model },
 *     by_call_site: { [callSite]: { prompt, completion, ... } },
 *     by_model:     { [model]:    { prompt, completion, ... } },
 *     context_window_tokens: 200000,
 *     turn_count: <number of LLM calls in this session>,
 *   }
 *
 * Notes:
 * - "totals" 是累计值（成本、调用次数视角）—— 显示历史投入。
 * - "latest" 是最近一次调用的 input 分量 —— 这个是当前 context window 实际
 *   占用的 proxy（下一次调用会带上历史，所以 latest.total_input ≈ 这一刻
 *   context 已经填到多少）。把这个跟 context_window_tokens 比才有意义；
 *   早期实现把 totals.total_input 跟它比会算出超 1000% 的滑稽数字。
 * - Empty-session response: zeroed-out totals + null latest + empty maps + turn_count: 0.
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
      .select('call_site, model, prompt_tokens, completion_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd, created_at')
      .eq('session_id', id)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);

    const totals = {
      prompt: 0, completion: 0, cache_read: 0, cache_create: 0,
      total_input: 0, cost_usd: 0,
    };
    const byCallSite = {};
    const byModel = {};

    // latest = 最近一次主对话调用（ogilvy.turn）。工具调用（web_search /
    // read_webpage）走 Haiku 各自独立 prompt，input 跟主对话历史不相关，
    // 不能拿来当 context 占用 proxy。
    let latestTurnRow = null;

    for (const row of data || []) {
      if (row.call_site === 'ogilvy.turn') latestTurnRow = row;
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

    const latest = latestTurnRow
      ? {
          prompt: latestTurnRow.prompt_tokens || 0,
          cache_read: latestTurnRow.cache_read_input_tokens || 0,
          cache_create: latestTurnRow.cache_creation_input_tokens || 0,
          total_input:
            (latestTurnRow.prompt_tokens || 0) +
            (latestTurnRow.cache_read_input_tokens || 0) +
            (latestTurnRow.cache_creation_input_tokens || 0),
          completion: latestTurnRow.completion_tokens || 0,
          cost_usd: Number(latestTurnRow.cost_usd) || 0,
          model: latestTurnRow.model || null,
        }
      : null;

    return Response.json({
      totals,
      latest,
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
