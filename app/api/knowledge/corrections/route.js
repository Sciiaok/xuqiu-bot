/**
 * /api/knowledge/corrections
 *
 * GET   ?product_line_id=...&status=pending      → list
 * POST  { product_line_id, conversation_id, message_id?, customer_question?,
 *         medici_original_answer, human_corrected_answer, diff_summary? }
 *       → record a new correction
 * PUT   { product_line_id, correction_id, action: 'adopt'|'reject', overrides? }
 */
import { NextResponse } from 'next/server';
import { getTenantContext, findProductLineInTenant } from '../../../../lib/tenant-context.js';
import {
  recordCorrection,
  listCorrections,
  adoptCorrection,
  rejectCorrection,
} from '../../../../src/kb-corrections.service.js';

export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { searchParams } = new URL(request.url);
    const productLineId = searchParams.get('product_line_id');
    const status = searchParams.get('status') || 'pending';
    if (!productLineId) return NextResponse.json({ error: 'product_line_id required' }, { status: 400 });
    const line = await findProductLineInTenant({ tenantId: ctx.tenantId, productLineId });
    if (!line) return NextResponse.json({ error: 'Product line not found' }, { status: 404 });
    const items = await listCorrections({
      tenantId: ctx.tenantId,
      productLineId,
      status,
    });
    return NextResponse.json({ items });
  } catch (e) {
    console.error('[knowledge/corrections] GET', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json();
    const {
      product_line_id, conversation_id, message_id, customer_question,
      medici_original_answer, human_corrected_answer, diff_summary,
    } = body;
    if (!product_line_id || !conversation_id || !medici_original_answer || !human_corrected_answer) {
      return NextResponse.json({
        error: 'product_line_id, conversation_id, medici_original_answer, human_corrected_answer required',
      }, { status: 400 });
    }
    const line = await findProductLineInTenant({ tenantId: ctx.tenantId, productLineId: product_line_id });
    if (!line) return NextResponse.json({ error: 'Product line not found' }, { status: 404 });

    const id = await recordCorrection(
      { tenantId: ctx.tenantId, productLineId: product_line_id },
      {
        conversationId: conversation_id,
        messageId: message_id,
        customerQuestion: customer_question,
        mediciOriginalAnswer: medici_original_answer,
        humanCorrectedAnswer: human_corrected_answer,
        diffSummary: diff_summary,
        suggestedKbAction: 'add_qa',
        createdBy: ctx.user?.id,
      }
    );
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    console.error('[knowledge/corrections] POST', e);
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

export async function PUT(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json();
    const { correction_id, action, product_line_id, overrides } = body;
    if (!correction_id || !action || !product_line_id) {
      return NextResponse.json({ error: 'correction_id, action, product_line_id required' }, { status: 400 });
    }
    const line = await findProductLineInTenant({ tenantId: ctx.tenantId, productLineId: product_line_id });
    if (!line) return NextResponse.json({ error: 'Product line not found' }, { status: 404 });

    const cctx = { tenantId: ctx.tenantId, productLineId: product_line_id };
    if (action === 'adopt') {
      const qaId = await adoptCorrection(correction_id, cctx, {
        resolvedBy: ctx.user?.id,
        overrides,
      });
      return NextResponse.json({ ok: true, qa_snippet_id: qaId });
    }
    if (action === 'reject') {
      await rejectCorrection(correction_id, cctx, { resolvedBy: ctx.user?.id });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    console.error('[knowledge/corrections] PUT', e);
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
