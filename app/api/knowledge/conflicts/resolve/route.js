import { NextResponse } from 'next/server';
import supabase from '../../../../../lib/supabase.js';
import { getTenantContext, findAgentInTenant } from '../../../../../lib/tenant-context.js';
import { resolveConflict } from '../../../../../src/kb-upload.service.js';

/**
 * POST /api/knowledge/conflicts/resolve
 * Resolve a knowledge conflict between old and new knowledge points.
 *
 * Body: {
 *   resolution: "use_new" | "keep_old" | "coexist",
 *   new_point_id: "uuid",
 *   old_point_id: "uuid"
 * }
 */
export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { resolution, new_point_id, old_point_id } = body;

    if (!resolution || !new_point_id || !old_point_id) {
      return NextResponse.json(
        { error: 'resolution, new_point_id, and old_point_id are required' },
        { status: 400 }
      );
    }

    if (!['use_new', 'keep_old', 'coexist'].includes(resolution)) {
      return NextResponse.json(
        { error: 'resolution must be one of: use_new, keep_old, coexist' },
        { status: 400 }
      );
    }

    // 验两条 point 的 agent 都归当前 tenant
    const { data: points, error: fetchErr } = await supabase
      .from('kb_knowledge_points')
      .select('id, agent_id')
      .in('id', [new_point_id, old_point_id]);
    if (fetchErr) throw fetchErr;
    if (!points || points.length !== 2) {
      return NextResponse.json({ error: 'Knowledge point not found' }, { status: 404 });
    }
    for (const p of points) {
      if (!(await findAgentInTenant({ tenantId: ctx.tenantId, agentId: p.agent_id }))) {
        return NextResponse.json({ error: 'Knowledge point not found' }, { status: 404 });
      }
    }

    await resolveConflict(resolution, new_point_id, old_point_id);

    return NextResponse.json({ success: true, resolution });
  } catch (error) {
    console.error('[knowledge/conflicts/resolve] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
