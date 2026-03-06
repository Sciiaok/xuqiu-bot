import { NextResponse } from 'next/server';
import { createClient } from '../../../../../lib/supabase-server.js';
import {
  startHumanTakeover,
  endHumanTakeover,
  findConversationById,
} from '../../../../../lib/repositories/conversation.repository.js';

/**
 * POST /api/conversations/[id]/takeover - Start human takeover
 */
export async function POST(request, { params }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const conversation = await findConversationById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const updated = await startHumanTakeover(id);
    console.log(`Human takeover started by ${user.email} for conversation ${id}`);

    return NextResponse.json({ success: true, conversation: updated });
  } catch (error) {
    console.error('Error starting takeover:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/conversations/[id]/takeover - End human takeover
 */
export async function DELETE(request, { params }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const updated = await endHumanTakeover(id);
    console.log(`Human takeover ended by ${user.email} for conversation ${id}`);

    return NextResponse.json({ success: true, conversation: updated });
  } catch (error) {
    console.error('Error ending takeover:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500 }
    );
  }
}
