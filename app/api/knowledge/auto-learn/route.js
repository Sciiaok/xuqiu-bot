import { NextResponse } from 'next/server';
import { runAutoLearn } from '../../../../src/kb-auto-learn.service.js';

export const maxDuration = 120;

/**
 * POST /api/knowledge/auto-learn
 * Trigger auto-learn: analyze recent operator conversations and extract knowledge drafts.
 * Intended to be called by a cron job (weekly) or manually.
 *
 * Body: { agent_id, days? }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { agent_id, days } = body;

    if (!agent_id) {
      return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
    }

    const result = await runAutoLearn(agent_id, days || 7);

    return NextResponse.json(result);
  } catch (error) {
    console.error('[knowledge/auto-learn] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
