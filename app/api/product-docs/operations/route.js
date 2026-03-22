import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabase-server.js';
import supabase from '../../../../lib/supabase.js';

export async function GET(request) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');
    const limit = parseInt(searchParams.get('limit') || '20', 10);

    let query = supabase
      .from('product_doc_operations')
      .select('id, document_id, agent_id, operation, operator, details, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (agentId) {
      query = query.eq('agent_id', agentId);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('[product-docs/operations] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
