import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../lib/demo-mode.js';
import { createClient } from '../../../../lib/supabase-server.js';
import supabase from '../../../../lib/supabase.js';

const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

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
    const model = formData.get('model');

    if (!file || !agentId || !model) {
      return NextResponse.json(
        { error: 'file, agent_id, and model are required' },
        { status: 400 }
      );
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: 'Only image files (JPEG, PNG, WebP, GIF) are supported' },
        { status: 400 }
      );
    }

    // Verify agent exists
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
    const storagePath = `${agent.product_line}/${model}/${Date.now()}_${safeName}`;

    // Upload to storage
    const { error: uploadError } = await authClient.storage
      .from('product-assets')
      .upload(storagePath, buffer, { contentType: file.type });

    if (uploadError) {
      return NextResponse.json(
        { error: `Upload failed: ${uploadError.message}` },
        { status: 500 }
      );
    }

    // Create record
    const { data: asset, error: dbError } = await supabase
      .from('product_assets')
      .insert({
        agent_id: agentId,
        model,
        filename: file.name,
        storage_path: storagePath,
        content_type: file.type,
      })
      .select('id, model, filename, storage_path, content_type, created_at')
      .single();

    if (dbError) {
      return NextResponse.json(
        { error: `DB insert failed: ${dbError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json(asset);
  } catch (error) {
    console.error('[product-assets/upload] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
