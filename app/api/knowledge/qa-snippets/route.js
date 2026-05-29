/**
 * /api/knowledge/qa-snippets
 *
 * GET    ?product_line_id=...&include_inactive=true   → list snippets
 * PUT    { snippet_id, product_line_id, ...patch }
 * DELETE ?snippet_id=...&product_line_id=...
 *
 * Note: there's no POST. New snippets are produced ONLY by the corrections
 * pipeline (src/kb-corrections.service.js) — manual creation was removed.
 */
import { NextResponse } from 'next/server';
import { getTenantContext, findProductLineInTenant } from '../../../../lib/tenant-context.js';
import {
  listQaSnippets,
  updateQaSnippet,
  deleteQaSnippet,
} from '../../../../src/kb-qa-snippets.service.js';

async function authLine(request) {
  const ctx = await getTenantContext();
  if (!ctx) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const { searchParams } = new URL(request.url);
  const productLineId = searchParams.get('product_line_id');
  if (!productLineId) return { error: NextResponse.json({ error: 'product_line_id required' }, { status: 400 }) };
  const line = await findProductLineInTenant({ tenantId: ctx.tenantId, productLineId });
  if (!line) return { error: NextResponse.json({ error: 'Product line not found' }, { status: 404 }) };
  return { ctx, line };
}

async function authLineFromBody(body) {
  const ctx = await getTenantContext();
  if (!ctx) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const productLineId = body?.product_line_id;
  if (!productLineId) return { error: NextResponse.json({ error: 'product_line_id required' }, { status: 400 }) };
  const line = await findProductLineInTenant({ tenantId: ctx.tenantId, productLineId });
  if (!line) return { error: NextResponse.json({ error: 'Product line not found' }, { status: 404 }) };
  return { ctx, line };
}

export async function GET(request) {
  try {
    const auth = await authLine(request);
    if (auth.error) return auth.error;
    const { searchParams } = new URL(request.url);
    const includeInactive = searchParams.get('include_inactive') === 'true';
    const snippets = await listQaSnippets({
      tenantId: auth.ctx.tenantId,
      productLineId: auth.line.id,
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
    const { snippet_id, product_line_id, ...rest } = body;
    if (!snippet_id) return NextResponse.json({ error: 'snippet_id required' }, { status: 400 });
    const auth = await authLineFromBody({ product_line_id });
    if (auth.error) return auth.error;
    await updateQaSnippet(snippet_id, {
      questions: rest.questions,
      answer: rest.answer,
      applicableWhen: rest.applicable_when,
      priority: rest.priority,
      isActive: rest.is_active,
    }, { tenantId: auth.ctx.tenantId, productLineId: auth.line.id });
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
    const productLineId = searchParams.get('product_line_id');
    if (!snippetId || !productLineId) {
      return NextResponse.json({ error: 'snippet_id and product_line_id required' }, { status: 400 });
    }
    const line = await findProductLineInTenant({ tenantId: ctx.tenantId, productLineId });
    if (!line) return NextResponse.json({ error: 'Product line not found' }, { status: 404 });
    await deleteQaSnippet(snippetId, { tenantId: ctx.tenantId, productLineId });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[knowledge/qa-snippets] DELETE', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
