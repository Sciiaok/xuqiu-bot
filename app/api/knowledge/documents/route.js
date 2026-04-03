import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';

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

    const { data, error } = await supabase
      .from('kb_documents')
      .select('*')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ documents: data || [] });
  } catch (error) {
    console.error('[knowledge/documents] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * DELETE /api/knowledge/documents
 * Delete a knowledge document and all its associated data.
 * Body: { doc_id: "uuid" }
 */
export async function DELETE(request) {
  try {
    const body = await request.json();
    const { doc_id } = body;

    if (!doc_id) {
      return NextResponse.json({ error: 'doc_id is required' }, { status: 400 });
    }

    // Get document info for storage cleanup
    const { data: doc } = await supabase
      .from('kb_documents')
      .select('storage_path')
      .eq('id', doc_id)
      .single();

    // Delete from storage if path exists
    if (doc?.storage_path) {
      await supabase.storage.from('kb-assets').remove([doc.storage_path]);
    }

    // Delete document (cascades to kb_knowledge_points, kb_products, kb_shipping_routes)
    const { error } = await supabase
      .from('kb_documents')
      .delete()
      .eq('id', doc_id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[knowledge/documents] Delete error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
