import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';

/**
 * GET /api/knowledge/gaps?agent_id=xxx&status=open
 * List knowledge gaps for an agent.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');
    const status = searchParams.get('status') || 'open';

    if (!agentId) {
      return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('kb_knowledge_gaps')
      .select('*')
      .eq('agent_id', agentId)
      .eq('status', status)
      .order('occurrence_count', { ascending: false })
      .limit(100);

    if (error) throw error;

    return NextResponse.json({ gaps: data || [] });
  } catch (error) {
    console.error('[knowledge/gaps] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * PUT /api/knowledge/gaps
 * Update gap status (resolve or ignore).
 * Body: { gap_id, status: 'resolved'|'ignored', resolved_by? }
 */
export async function PUT(request) {
  try {
    const { gap_id, status, resolved_by } = await request.json();

    if (!gap_id || !status) {
      return NextResponse.json({ error: 'gap_id and status are required' }, { status: 400 });
    }

    const update = { status };
    if (resolved_by) update.resolved_by = resolved_by;

    const { error } = await supabase
      .from('kb_knowledge_gaps')
      .update(update)
      .eq('id', gap_id);

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[knowledge/gaps] PUT Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
