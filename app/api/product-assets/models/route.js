import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabase-server.js';
import supabase from '../../../../lib/supabase.js';

/** Return distinct models from product_specs for a given agent. */
export async function GET(request) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');

    if (!agentId) {
      return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('product_specs')
      .select('model')
      .eq('agent_id', agentId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const models = [...new Set(data.map(r => r.model))].sort();
    return NextResponse.json(models);
  } catch (error) {
    console.error('[product-assets/models] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
