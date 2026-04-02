import { NextResponse } from 'next/server';
import supabase from '../../../../../../lib/supabase.js';

/**
 * GET /api/knowledge/test-chat/sessions/:id
 * Get messages for a specific test chat session.
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;

    const { data: messages, error } = await supabase
      .from('kb_test_messages')
      .select('id, role, content, sources, search_meta, created_at')
      .eq('session_id', id)
      .order('created_at', { ascending: true });

    if (error) throw error;

    return NextResponse.json({ messages: messages || [] });
  } catch (error) {
    console.error('[knowledge/test-chat/sessions/:id] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * DELETE /api/knowledge/test-chat/sessions/:id
 * Delete a test chat session.
 */
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const { error } = await supabase
      .from('kb_test_sessions')
      .delete()
      .eq('id', id);

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[knowledge/test-chat/sessions/:id] DELETE Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
