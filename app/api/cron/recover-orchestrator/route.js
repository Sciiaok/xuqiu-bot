import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';
import { orchestrate } from '../../../../src/campaign-orchestrator.service.js';
import { drainToRedis } from '../../../../lib/sse.js';
import { streamKey } from '../../../../lib/redis.js';

const STALE_THRESHOLD_MINUTES = 5;

/**
 * GET /api/cron/recover-orchestrator
 *
 * Scans for orchestrator sessions stuck in 'running' state (no update for 5+ minutes).
 * These are sessions where the server crashed mid-orchestration.
 * Resumes them from their checkpoint via orchestrate(), which has built-in recovery.
 */
export async function GET(request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000).toISOString();
  const maxAgeCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: staleSessions, error } = await supabase
    .from('orchestrator_sessions')
    .select('id, brief_id, current_phase, updated_at')
    .eq('status', 'running')
    .lt('updated_at', staleCutoff)
    .gt('updated_at', maxAgeCutoff)  // Only recover sessions from the last 24h
    .limit(5);

  if (error) {
    console.error('[recover-orchestrator] query failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!staleSessions?.length) {
    return NextResponse.json({ recovered: 0 });
  }

  const results = [];

  for (const session of staleSessions) {
    const staleMinutes = Math.round((Date.now() - new Date(session.updated_at).getTime()) / 60000);
    console.log(`[recover-orchestrator] Recovering session ${session.id} (stale ${staleMinutes}m, phase: ${session.current_phase})`);

    try {
      // orchestrate() detects status=running + checkpoint and resumes automatically.
      // Drain events to Redis so the frontend can pick them up via /stream reconnect.
      const generator = orchestrate(session.id);
      const key = streamKey(session.brief_id);
      await drainToRedis(generator, key);
      console.log(`[recover-orchestrator] Session ${session.id} recovered successfully`);
      results.push({ session_id: session.id, status: 'recovered' });
    } catch (err) {
      console.error(`[recover-orchestrator] Session ${session.id} recovery failed:`, err.message);
      // Mark as interrupted so it doesn't get retried endlessly
      await supabase
        .from('orchestrator_sessions')
        .update({ status: 'interrupted', orchestrator_state: null })
        .eq('id', session.id)
        .eq('status', 'running');
      results.push({ session_id: session.id, status: 'failed', error: err.message });
    }
  }

  return NextResponse.json({ recovered: results.length, results });
}
