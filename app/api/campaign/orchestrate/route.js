import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabase-server.js';
import { createBrief } from '../../../../lib/repositories/campaign-brief.repository.js';
import { createSession } from '../../../../lib/repositories/orchestrator.repository.js';

/**
 * POST /api/campaign/orchestrate
 *
 * Create a new campaign session (brief + orchestrator session).
 * This is the single entry point — the orchestrator controls the entire flow
 * including intake (brief collection), strategy, creative, and execution.
 */
export async function POST(request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const brief = await createBrief(body.id || null);
    const session = await createSession(brief.id, { status: 'intake', current_phase: 'intake' });
    return NextResponse.json({ brief_id: brief.id, session_id: session.id }, { status: 201 });
  } catch (error) {
    console.error('[campaign/orchestrate] Error creating session:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
