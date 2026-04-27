import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import {
  startHumanTakeover,
  endHumanTakeover,
  findConversationById,
} from '../../../../../lib/repositories/conversation.repository.js';

async function loadConversationInTenant(conversationId, tenantId) {
  const conv = await findConversationById(conversationId);
  if (!conv || conv.tenant_id !== tenantId) return null;
  return conv;
}

/**
 * POST /api/conversations/[id]/takeover - Start human takeover
 */
export async function POST(request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    if (!(await loadConversationInTenant(id, ctx.tenantId))) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const updated = await startHumanTakeover(id);
    console.log(`Human takeover started by ${ctx.user.email} for conversation ${id}`);

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
    const ctx = await getTenantContext();
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    if (!(await loadConversationInTenant(id, ctx.tenantId))) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const updated = await endHumanTakeover(id);
    console.log(`Human takeover ended by ${ctx.user.email} for conversation ${id}`);

    return NextResponse.json({ success: true, conversation: updated });
  } catch (error) {
    console.error('Error ending takeover:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500 }
    );
  }
}
