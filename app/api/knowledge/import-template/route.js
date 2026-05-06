/**
 * POST /api/knowledge/import-template
 *
 * Structured Excel template upload — bypasses LLM extraction and writes
 * verified rows directly to kb_products / kb_shipping_routes.
 *
 * multipart/form-data:
 *   file:           .xlsx file
 *   agent_id:       agent UUID
 *   template_kind:  'products' | 'shipping_routes'
 */
import { NextResponse } from 'next/server';
import { getTenantContext, findAgentInTenant } from '../../../../lib/tenant-context.js';
import { importTemplate } from '../../../../src/kb-excel-template.service.js';

export const maxDuration = 60;

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const VALID_KINDS = new Set(['products', 'shipping_routes']);

export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const form = await request.formData();
    const file = form.get('file');
    const agentId = form.get('agent_id');
    const templateKind = form.get('template_kind');

    if (!file || !agentId || !templateKind) {
      return NextResponse.json({ error: 'file, agent_id, template_kind are required' }, { status: 400 });
    }
    if (!VALID_KINDS.has(String(templateKind))) {
      return NextResponse.json({ error: `template_kind must be one of: ${[...VALID_KINDS].join(', ')}` }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: `文件过大（限 20 MB）` }, { status: 413 });
    }

    const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId });
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await importTemplate(
      { tenantId: ctx.tenantId, agentId, productLineId: agent.product_line },
      buffer,
      String(templateKind),
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error('[knowledge/import-template] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
