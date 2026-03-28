import { NextResponse } from 'next/server';
import { createClient } from '../../../lib/supabase-server.js';
import supabase from '../../../lib/supabase.js';

export async function GET(request) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');
    const model = searchParams.get('model');

    let query = supabase
      .from('product_assets')
      .select('id, agent_id, model, filename, storage_path, content_type, created_at')
      .order('created_at', { ascending: false });

    if (agentId) query = query.eq('agent_id', agentId);
    if (model) query = query.eq('model', model);

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('[product-assets] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
