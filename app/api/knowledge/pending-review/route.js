/**
 * /api/knowledge/pending-review
 *
 * GET   ?agent_id=...&status=pending      → list
 * POST  { review_id, action: 'approve'|'reject', note?, agent_id }
 */
import { NextResponse } from 'next/server';
import { getTenantContext, findAgentInTenant } from '../../../../lib/tenant-context.js';
import {
  listPending,
  approveReview,
  rejectReview,
} from '../../../../src/kb-pending-review.service.js';

export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');
    const status = searchParams.get('status') || 'pending';
    if (!agentId) return NextResponse.json({ error: 'agent_id required' }, { status: 400 });
    const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId });
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    const rows = await listPending({
      tenantId: ctx.tenantId,
      productLineId: agent.product_line,
      status,
    });
    return NextResponse.json({ items: rows });
  } catch (e) {
    console.error('[knowledge/pending-review] GET', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json();
    const { review_id, action, note, agent_id } = body;
    if (!review_id || !action || !agent_id) {
      return NextResponse.json({ error: 'review_id, action, agent_id required' }, { status: 400 });
    }
    const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId: agent_id });
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const reviewCtx = { tenantId: ctx.tenantId, productLineId: agent.product_line };

    if (action === 'approve') {
      const id = await approveReview(review_id, reviewCtx, { resolvedBy: ctx.user?.id });
      return NextResponse.json({ ok: true, target_id: id });
    }
    if (action === 'reject') {
      await rejectReview(review_id, reviewCtx, { resolvedBy: ctx.user?.id, note });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    console.error('[knowledge/pending-review] POST', e);
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
