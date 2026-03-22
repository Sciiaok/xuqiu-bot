import { NextResponse } from 'next/server';
import { createClient } from '../../../../../lib/supabase-server.js';
import supabase from '../../../../../lib/supabase.js';

export async function GET(request, { params }) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const { data, error } = await supabase
      .from('product_specs')
      .select('id, model, brand, product_line, specs, created_at')
      .eq('document_id', id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('[product-docs/specs] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
