import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabase-server.js';
import { getAssets } from '../../../../src/aigc.service.js';

/**
 * GET /api/aigc/library
 *
 * Query params:
 *   - scope: 'conversation' | 'user' (required)
 *   - conversation_id: uuid (required when scope=conversation)
 *   - limit: number (default 50)
 *   - offset: number (default 0)
 *
 * When scope=user, returns all assets created by the authenticated user.
 * When scope=conversation, returns assets linked to a specific conversation.
 *
 * Returns: { data: Asset[], total: number }
 */
export async function GET(request) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const scope = searchParams.get('scope');
    const conversationId = searchParams.get('conversation_id');
    const limit = Math.min(parseInt(searchParams.get('limit')) || 50, 200);
    const offset = parseInt(searchParams.get('offset')) || 0;

    if (!scope || !['conversation', 'user'].includes(scope)) {
      return NextResponse.json(
        { error: 'scope is required (conversation | user)' },
        { status: 400 }
      );
    }

    if (scope === 'conversation' && !conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required when scope=conversation' },
        { status: 400 }
      );
    }

    const result = await getAssets({
      scope,
      conversationId,
      userId: user.id,
      limit,
      offset,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[aigc/library] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
