import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';
import {
  getDocumentsByAgent,
  getDocumentById,
  deleteDocumentById,
} from '../../../../lib/repositories/knowledge-base.repository.js';

/**
 * GET /api/knowledge/documents?agent_id=xxx
 * List all knowledge documents for an agent.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');

    if (!agentId) {
      return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
    }

    const documents = await getDocumentsByAgent(agentId);
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
    const { searchParams } = new URL(request.url);
    let docId = searchParams.get('doc_id');
    if (!docId) {
      // Fallback: older clients POST JSON body
      const body = await request.json().catch(() => ({}));
      docId = body.doc_id;
    }

    if (!docId) {
      return NextResponse.json({ error: 'doc_id is required' }, { status: 400 });
    }

    // Clean up storage first (best-effort) — repo doesn't touch storage
    const doc = await getDocumentById(docId);
    if (doc?.storage_path) {
      await supabase.storage.from('kb-assets').remove([doc.storage_path]);
    }

    // Delete document (cascades to kb_knowledge_points, kb_products, kb_shipping_routes)
    await deleteDocumentById(docId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[knowledge/documents] Delete error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
