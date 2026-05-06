/**
 * /api/knowledge/qa-snippets
 *
 * GET    ?agent_id=...&include_inactive=true   → list snippets
 * PUT    { snippet_id, ...patch }
 * DELETE ?snippet_id=...
 *
 * Note: there's no POST. New snippets are produced ONLY by the corrections
 * pipeline (src/kb-corrections.service.js) — manual creation was removed.
 */
import { NextResponse } from 'next/server';
import { getTenantContext, findAgentInTenant } from '../../../../lib/tenant-context.js';
import {
  listQaSnippets,
  updateQaSnippet,
  deleteQaSnippet,
} from '../../../../src/kb-qa-snippets.service.js';

async function authAgent(request) {
  const ctx = await getTenantContext();
  if (!ctx) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agent_id');
  if (!agentId) return { error: NextResponse.json({ error: 'agent_id required' }, { status: 400 }) };
  const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId });
  if (!agent) return { error: NextResponse.json({ error: 'Agent not found' }, { status: 404 }) };
  return { ctx, agent };
}

async function authAgentFromBody(body, agentIdField = 'agent_id') {
  const ctx = await getTenantContext();
  if (!ctx) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const agentId = body?.[agentIdField];
  if (!agentId) return { error: NextResponse.json({ error: `${agentIdField} required` }, { status: 400 }) };
  const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId });
  if (!agent) return { error: NextResponse.json({ error: 'Agent not found' }, { status: 404 }) };
  return { ctx, agent };
}

export async function GET(request) {
  try {
    const auth = await authAgent(request);
    if (auth.error) return auth.error;
    const { searchParams } = new URL(request.url);
    const includeInactive = searchParams.get('include_inactive') === 'true';
    const snippets = await listQaSnippets({
      tenantId: auth.ctx.tenantId,
      productLineId: auth.agent.product_line,
      includeInactive,
    });
    return NextResponse.json({ snippets });
  } catch (e) {
    console.error('[knowledge/qa-snippets] GET', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { snippet_id, agent_id, ...rest } = body;
    if (!snippet_id) return NextResponse.json({ error: 'snippet_id required' }, { status: 400 });
    const auth = await authAgentFromBody({ agent_id });
    if (auth.error) return auth.error;
    await updateQaSnippet(snippet_id, {
      questions: rest.questions,
      answer: rest.answer,
      applicableWhen: rest.applicable_when,
      priority: rest.priority,
      isActive: rest.is_active,
    }, { tenantId: ctx.tenantId, productLineId: auth.agent.product_line });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[knowledge/qa-snippets] PUT', e);
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

export async function DELETE(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { searchParams } = new URL(request.url);
    const snippetId = searchParams.get('snippet_id');
    const agentId = searchParams.get('agent_id');
    if (!snippetId || !agentId) return NextResponse.json({ error: 'snippet_id and agent_id required' }, { status: 400 });
    const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId });
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    await deleteQaSnippet(snippetId, { tenantId: ctx.tenantId, productLineId: agent.product_line });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[knowledge/qa-snippets] DELETE', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
