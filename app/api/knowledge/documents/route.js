import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';
import { getSupabaseAdmin } from '../../../../lib/supabase-admin.js';
import { getTenantContext, findAgentInTenant } from '../../../../lib/tenant-context.js';
import {
  getDocumentsByProductLine,
  getDocumentById,
  deleteDocumentById,
} from '../../../../lib/repositories/knowledge-base.repository.js';

const ASSET_BUCKET = 'kb-assets';

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

    // Cascade order matters:
    //   1. kb_pending_review (FK source_doc_id, no ON DELETE clause → would
    //      otherwise block doc deletion with FK violation).
    //   2. kb_assets rows + their storage objects (FK is ON DELETE SET NULL,
    //      so without explicit cleanup the rows survive as orphans and
    //      Medici keeps serving images from a deleted doc).
    //   3. Original document blob in storage.
    //   4. kb_documents row itself (which cascades knowledge_points / products /
    //      shipping_routes / corrections / gaps via existing FK ON DELETE).
    const cascade = await cascadeDeleteDocumentArtifacts({ tenantId: ctx.tenantId, docId });

    if (doc.storage_path) {
      await supabase.storage.from(ASSET_BUCKET).remove([doc.storage_path])
        .catch((e) => console.warn('[knowledge/documents] original blob remove failed:', e?.message));
    }

    await deleteDocumentById(docId);

    return NextResponse.json({ success: true, cascade });
  } catch (error) {
    console.error('[knowledge/documents] Delete error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Wipe artifacts that reference a doc but aren't covered by FK ON DELETE
 * CASCADE: pending_review rows (which would block deletion entirely) and
 * auto-extracted kb_assets + their storage objects (which would survive as
 * orphans because the FK is ON DELETE SET NULL).
 *
 * Best-effort per-step: a failure on one resource doesn't block the rest —
 * better partial cleanup than leaving the doc undeletable.
 */
async function cascadeDeleteDocumentArtifacts({ tenantId, docId }) {
  const out = { pending_review: 0, assets_rows: 0, assets_storage: 0 };
  const admin = getSupabaseAdmin();

  // Pending review rows referencing this doc (no FK cascade → must clear first)
  try {
    const { data: pending } = await supabase
      .from('kb_pending_review')
      .select('id')
      .eq('source_doc_id', docId);
    if (pending && pending.length > 0) {
      const { error } = await supabase
        .from('kb_pending_review')
        .delete()
        .eq('source_doc_id', docId);
      if (error) console.warn('[knowledge/documents] pending_review cleanup failed:', error.message);
      else out.pending_review = pending.length;
    }
  } catch (e) {
    console.warn('[knowledge/documents] pending_review cleanup threw:', e?.message);
  }

  // Auto-extracted assets — query first so we know which storage objects to
  // remove. Scope to tenant_id + source_doc_id (paths can include manually
  // uploaded assets at non-extracted/ prefixes; those have source_doc_id=NULL
  // so they won't match — but we double-check by listing storage_path).
  try {
    const { data: assets } = await supabase
      .from('kb_assets')
      .select('id, storage_path')
      .eq('tenant_id', tenantId)
      .eq('source_doc_id', docId);
    if (assets && assets.length > 0) {
      const paths = assets.map((a) => a.storage_path).filter(Boolean);
      if (paths.length > 0) {
        try {
          await admin.storage.from(ASSET_BUCKET).remove(paths);
          out.assets_storage = paths.length;
        } catch (e) {
          console.warn('[knowledge/documents] asset storage cleanup failed:', e?.message);
        }
      }
      const ids = assets.map((a) => a.id);
      const { error } = await supabase.from('kb_assets').delete().in('id', ids);
      if (error) console.warn('[knowledge/documents] kb_assets cleanup failed:', error.message);
      else out.assets_rows = assets.length;
    }
  } catch (e) {
    console.warn('[knowledge/documents] kb_assets cleanup threw:', e?.message);
  }

  return out;
}
