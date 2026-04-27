import { NextResponse } from 'next/server';
import supabase from '../../../../../lib/supabase.js';
import { getTenantContext, findAgentInTenant } from '../../../../../lib/tenant-context.js';
import { getDocumentById } from '../../../../../lib/repositories/knowledge-base.repository.js';

/**
 * GET /api/knowledge/documents/download?doc_id=xxx
 * Returns a short-lived signed URL for downloading the original uploaded file.
 */
export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const docId = searchParams.get('doc_id');
    if (!docId) {
      return NextResponse.json({ error: 'doc_id is required' }, { status: 400 });
    }

    const doc = await getDocumentById(docId);
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }
    // 验 doc 所属 agent 归属当前 tenant —— 否则 doc_id 一旦泄露就能跨 tenant 下载文件。
    if (!(await findAgentInTenant({ tenantId: ctx.tenantId, agentId: doc.agent_id }))) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }
    if (!doc.storage_path) {
      return NextResponse.json({ error: 'No file stored for this document' }, { status: 404 });
    }

    const { data, error } = await supabase.storage
      .from('kb-assets')
      .createSignedUrl(doc.storage_path, 3600, { download: doc.filename });

    if (error || !data?.signedUrl) {
      return NextResponse.json(
        { error: error?.message || 'Failed to create signed URL' },
        { status: 500 }
      );
    }

    return NextResponse.json({ url: data.signedUrl, filename: doc.filename });
  } catch (error) {
    console.error('[knowledge/documents/download] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
