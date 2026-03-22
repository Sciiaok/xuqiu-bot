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

    let query = supabase
      .from('product_documents')
      .select('id, filename, agent_id, doc_type, status, error_message, page_count, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (agentId) {
      query = query.eq('agent_id', agentId);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('[product-docs] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
