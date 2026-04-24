import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../lib/demo-mode.js';
import { createClient } from '../../../../lib/supabase-server.js';
import {
  findProductLineById,
  findAgentIdByProductLine,
  updateProductLine,
  deactivateProductLine,
} from '../../../../lib/repositories/product-line.repository.js';
import { invalidateMediciCache } from '../../../../src/agents/medici/config.js';

async function requireUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function GET(_request, { params }) {
  try {
    if (!(await requireUser())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    const line = await findProductLineById(id);
    if (!line) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const agent_id = await findAgentIdByProductLine(line.id);
    return NextResponse.json({ line: { ...line, agent_id } });
  } catch (err) {
    console.error('GET /api/product-lines/[id] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  const demoResponse = demoGuard({ line: { id: 'demo' } });
  if (demoResponse) return demoResponse;

  try {
    if (!(await requireUser())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    const body = await request.json();
    const line = await updateProductLine(id, body);
    invalidateMediciCache(id);
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
  const demoResponse = demoGuard({ ok: true });
  if (demoResponse) return demoResponse;

  try {
    if (!(await requireUser())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    const line = await deactivateProductLine(id);
    invalidateMediciCache(id);
    return NextResponse.json({ line });
  } catch (err) {
    console.error('DELETE /api/product-lines/[id] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
