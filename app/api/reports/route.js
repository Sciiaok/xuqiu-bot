import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import supabase from '@/lib/supabase';
import { generateReport } from '@/lib/services/report-generator';

/**
 * GET /api/reports — List reports with optional filters
 * Query params: type, agentId, from, to, limit, offset
 */
export async function GET(request) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type'); // daily|weekly|monthly|manual
    const from = searchParams.get('from'); // date string
    const to = searchParams.get('to');
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
    const offset = parseInt(searchParams.get('offset') || '0');

    let query = supabase
      .from('ai_reports')
      .select('id, type, status, agent_ids, period_start, period_end, summary_line, kpi_snapshot, retry_count, error_message, generated_at, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (type) query = query.eq('type', type);
    if (from) query = query.gte('period_end', from);
    if (to) query = query.lte('period_start', to);

    const { data, error, count } = await query;
    if (error) throw error;

    return NextResponse.json({ reports: data, total: count });
  } catch (err) {
    console.error('[api/reports] GET error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/reports — Create a manual report
 * Body: { periodStart, periodEnd, agentIds? }
 */
export async function POST(request) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { periodStart, periodEnd, agentIds } = body;

    if (!periodStart || !periodEnd) {
      return NextResponse.json({ error: 'periodStart and periodEnd are required' }, { status: 400 });
    }

    const report = await generateReport({
      type: 'manual',
      periodStart,
      periodEnd,
      agentIds: agentIds || [],
    });

    return NextResponse.json({ report });
  } catch (err) {
    console.error('[api/reports] POST error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
