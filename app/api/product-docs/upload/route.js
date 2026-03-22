import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../lib/demo-mode.js';
import { createClient } from '../../../../lib/supabase-server.js';
import supabase from '../../../../lib/supabase.js';
import { processPdfDocument } from '../../../../src/product-knowledge.service.js';

export async function POST(request) {
  const demoResponse = demoGuard({ success: true, message: 'Demo mode' });
  if (demoResponse) return demoResponse;

  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file');
    const agentId = formData.get('agent_id');

    if (!file || !agentId) {
      return NextResponse.json(
        { error: 'file and agent_id are required' },
        { status: 400 }
      );
    }

    // Validate file type
    if (file.type !== 'application/pdf') {
      return NextResponse.json(
        { error: 'Only PDF files are supported' },
        { status: 400 }
      );
    }

    // Get agent info
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, product_line')
      .eq('id', agentId)
      .single();

    if (agentError || !agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${agent.product_line}/${Date.now()}_${safeName}`;

    // Upload to Supabase Storage using the authenticated client (RLS requires auth)
    const { error: uploadError } = await authClient.storage
      .from('product-docs')
      .upload(storagePath, buffer, { contentType: 'application/pdf' });

    if (uploadError) {
      return NextResponse.json(
        { error: `Upload failed: ${uploadError.message}` },
        { status: 500 }
      );
    }

    // Create document record
    const { data: doc, error: docError } = await supabase
      .from('product_documents')
      .insert({
        agent_id: agentId,
        filename: file.name,
        storage_path: storagePath,
        status: 'pending',
      })
      .select('id')
      .single();

    if (docError) {
      return NextResponse.json(
        { error: `DB insert failed: ${docError.message}` },
        { status: 500 }
      );
    }

    // Log upload operation
    await supabase.from('product_doc_operations').insert({
      document_id: doc.id,
      agent_id: agentId,
      operation: 'upload',
      operator: user.email,
      details: { filename: file.name },
    });

    // Process PDF synchronously — Next.js terminates the execution context
    // after the response is sent, so fire-and-forget won't complete.
    let result;
    try {
      result = await processPdfDocument(buffer, doc.id, agentId, agent.product_line);
    } catch (err) {
      console.error(`[product-docs] Failed to process ${file.name}:`, err.message);
      return NextResponse.json({
        document_id: doc.id,
        status: 'error',
        error: err.message,
      });
    }

    return NextResponse.json({
      document_id: doc.id,
      status: 'ready',
      ...result,
    });
  } catch (error) {
    console.error('[product-docs/upload] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
