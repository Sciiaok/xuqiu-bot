import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import {
  findProductLineById,
  findAgentIdByProductLine,
  updateProductLine,
  deactivateProductLine,
} from '../../../../lib/repositories/product-line.repository.js';
import { invalidateMediciCache } from '../../../../src/agents/medici/config.js';

export async function GET(_request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const line = await findProductLineById({ tenantId: ctx.tenantId, id });
    if (!line) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const agent_id = await findAgentIdByProductLine({ tenantId: ctx.tenantId, slug: line.id });
    return NextResponse.json({ line: { ...line, agent_id } });
  } catch (err) {
    console.error('GET /api/product-lines/[id] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const body = await request.json();
    const line = await updateProductLine({ tenantId: ctx.tenantId, id, updates: body });
    invalidateMediciCache({ tenantId: ctx.tenantId, id });
    return NextResponse.json({ line });
  } catch (err) {
    if (err.code === '23505') {
      return NextResponse.json(
        { error: 'This WhatsApp number is already bound to another product line' },
        { status: 409 },
      );
    }
    console.error('PUT /api/product-lines/[id] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(_request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const line = await deactivateProductLine({ tenantId: ctx.tenantId, id });
    invalidateMediciCache({ tenantId: ctx.tenantId, id });
    return NextResponse.json({ line });
  } catch (err) {
    console.error('DELETE /api/product-lines/[id] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
