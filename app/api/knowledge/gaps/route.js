import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';
import { getTenantContext, findAgentInTenant } from '../../../../lib/tenant-context.js';
import {
  getGapsByProductLine,
  updateGap,
} from '../../../../lib/repositories/knowledge-base.repository.js';

/**
 * GET /api/knowledge/gaps?agent_id=xxx&status=open
 * List knowledge gaps for an agent's product line.
 */
export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');
    const status = searchParams.get('status') || 'open';

    if (!agentId) {
      return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
    }
    const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const gaps = await getGapsByProductLine({
      tenantId: ctx.tenantId,
      productLineId: agent.product_line,
      status,
    });
    return NextResponse.json({ gaps });
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
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { gap_id, status, resolved_by } = await request.json();

    if (!gap_id || !status) {
      return NextResponse.json({ error: 'gap_id and status are required' }, { status: 400 });
    }

    // 验 gap 所属 agent 归属当前 tenant
    const { data: gap, error: fetchErr } = await supabase
      .from('kb_knowledge_gaps')
      .select('agent_id')
      .eq('id', gap_id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!gap || !(await findAgentInTenant({ tenantId: ctx.tenantId, agentId: gap.agent_id }))) {
      return NextResponse.json({ error: 'Gap not found' }, { status: 404 });
    }

    const updates = { status };
    if (resolved_by) updates.resolved_by = resolved_by;

    await updateGap(gap_id, updates);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[knowledge/gaps] PUT Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
