import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../lib/tenant-context.js';
import {
  getAllProductLines,
  createProductLine,
} from '../../../lib/repositories/product-line.repository.js';
import { invalidateMediciCache } from '../../../src/agents/medici/config.js';
import { markFirstProductLine } from '../../../lib/repositories/onboarding.repository.js';

const SLUG_RE = /^[a-z][a-z0-9_]{0,39}$/;

export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const activeOnly = new URL(request.url).searchParams.get('active') === 'true';
    const lines = await getAllProductLines({ tenantId: ctx.tenantId, activeOnly });
    return NextResponse.json({ lines });
  } catch (err) {
    console.error('GET /api/product-lines failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id, name } = await request.json();
    if (!id || !name) {
      return NextResponse.json({ error: 'id and name are required' }, { status: 400 });
    }
    if (!SLUG_RE.test(id)) {
      return NextResponse.json(
        { error: 'id must be lowercase letters, digits, underscore; start with a letter; ≤40 chars' },
        { status: 400 },
      );
    }

    const line = await createProductLine({ tenantId: ctx.tenantId, id, name });
    invalidateMediciCache({ tenantId: ctx.tenantId, id });
    await markFirstProductLine(ctx.tenantId);
    return NextResponse.json({ line }, { status: 201 });
  } catch (err) {
    if (err.code === '23505') {
      return NextResponse.json({ error: 'A product line with this id already exists' }, { status: 409 });
    }
    console.error('POST /api/product-lines failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
