import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '../../../../../lib/supabase-admin.js';
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

    // 私有 bucket（kb-assets）的 RLS 只放给 authenticated。这条路由跑在服务端，
    // 必须用 service role 才能签 URL；用 anon client 会被 RLS 挡掉，supabase
    // 把 403 伪装成 "Object not found" 回来。
    const { data, error } = await getSupabaseAdmin().storage
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
