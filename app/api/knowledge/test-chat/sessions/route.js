import { NextResponse } from 'next/server';
import supabase from '../../../../../lib/supabase.js';

/**
 * GET /api/knowledge/test-chat/sessions?agent_id=xxx
 * List test chat sessions for an agent.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');

    if (!agentId) {
      return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('kb_test_sessions')
      .select('id, title, message_count, created_at, updated_at')
      .eq('agent_id', agentId)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    return NextResponse.json({ sessions: data || [] });
  } catch (error) {
    console.error('[knowledge/test-chat/sessions] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
