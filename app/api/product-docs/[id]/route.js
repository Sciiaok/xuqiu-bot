import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../lib/demo-mode.js';
import { createClient } from '../../../../lib/supabase-server.js';
import supabase from '../../../../lib/supabase.js';

export async function DELETE(request, { params }) {
  const demoResponse = demoGuard({ success: true, message: 'Demo mode' });
  if (demoResponse) return demoResponse;

  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // Get document to find storage path
    const { data: doc, error: fetchError } = await supabase
      .from('product_documents')
      .select('id, agent_id, filename, storage_path')
      .eq('id', id)
      .single();

    if (fetchError || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Delete from storage (use authClient for RLS)
    await authClient.storage.from('product-docs').remove([doc.storage_path]);

    // Log delete operation before cascading delete removes the document
    await supabase.from('product_doc_operations').insert({
      document_id: id,
      agent_id: doc.agent_id,
      operation: 'delete',
      operator: user.email,
      details: { filename: doc.filename },
    });

    // Delete from DB (cascades to product_specs and product_embeddings)
    const { error: deleteError } = await supabase
      .from('product_documents')
      .delete()
      .eq('id', id);

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[product-docs/delete] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
