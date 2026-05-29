import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import {
  findProductLineById,
  updateProductLine,
} from '../../../../lib/repositories/product-line.repository.js';
import { invalidateMediciCache } from '../../../../src/agents/medici/config.js';

/**
 * PUT body whitelist. New IA exposes only these four customizables:
 *   产品线名称 / 价值判定标准 / 线索字段表 / (KB managed via /api/knowledge/*)
 *
 * 旧字段 catalog_description / domain_glossary / message_style_examples /
 * faq_message / wa_phone_number_id / is_active 不再从这里改：
 *   - 内容字段：从 dynamic_injection 撤了，UI 不暴露
 *   - 绑定与停用：phone 即入口，停用动作没了
 */
const ALLOWED_UPDATE_KEYS = new Set(['name', 'business_value_guidance', 'lead_fields']);

export async function GET(_request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const line = await findProductLineById({ tenantId: ctx.tenantId, id });
    if (!line) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ line });
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
    const updates = {};
    for (const k of Object.keys(body || {})) {
      if (ALLOWED_UPDATE_KEYS.has(k)) updates[k] = body[k];
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No allowed fields in request body' }, { status: 400 });
    }
    const line = await updateProductLine({ tenantId: ctx.tenantId, id, updates });
    invalidateMediciCache({ tenantId: ctx.tenantId, id });
    return NextResponse.json({ line });
  } catch (err) {
    console.error('PUT /api/product-lines/[id] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
