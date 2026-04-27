import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';
import { getTenantContext, findAgentInTenant } from '../../../../lib/tenant-context.js';
import {
  getDocumentsByProductLine,
  getDocumentById,
  deleteDocumentById,
} from '../../../../lib/repositories/knowledge-base.repository.js';

/**
 * GET /api/knowledge/documents?agent_id=xxx
 * List all knowledge documents for an agent's product line.
 */
export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');

    if (!agentId) {
      return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
    }
    const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const documents = await getDocumentsByProductLine({
      tenantId: ctx.tenantId,
      productLineId: agent.product_line,
    });
    return NextResponse.json({ documents });
  } catch (error) {
    console.error('[knowledge/documents] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * DELETE /api/knowledge/documents?doc_id=xxx
 * Delete a knowledge document and all its associated data.
 * Accepts doc_id from either query string or JSON body (for backwards compat).
 */
export async function DELETE(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    let docId = searchParams.get('doc_id');
    if (!docId) {
      const body = await request.json().catch(() => ({}));
      docId = body.doc_id;
    }

    if (!docId) {
      return NextResponse.json({ error: 'doc_id is required' }, { status: 400 });
    }

    // 验 doc 所属 agent 归属当前 tenant —— 否则 doc_id 一旦泄露就能跨 tenant 删数据。
    const doc = await getDocumentById(docId);
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }
    if (!(await findAgentInTenant({ tenantId: ctx.tenantId, agentId: doc.agent_id }))) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    if (doc.storage_path) {
      await supabase.storage.from('kb-assets').remove([doc.storage_path]);
    }

    await deleteDocumentById(docId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[knowledge/documents] Delete error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
