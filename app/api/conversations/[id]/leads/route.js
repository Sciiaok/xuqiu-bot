import { NextResponse } from 'next/server';
import { createClient } from '../../../../../lib/supabase-server.js';
import supabase from '../../../../../lib/supabase.js';
import { findConversationById } from '../../../../../lib/repositories/conversation.repository.js';

/**
 * GET /api/conversations/[id]/leads - Get leads for a conversation
 */
export async function GET(request, { params }) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const conversation = await findConversationById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, conversation_id, inquiry_quality, business_value, route, destination_country, car_model, product_name, qty_bucket, created_at, updated_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    return NextResponse.json({ leads: leads || [] });
  } catch (error) {
    console.error('Error fetching conversation leads:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500 }
    );
  }
}
