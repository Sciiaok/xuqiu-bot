import { createClient } from '../../../../lib/supabase-server.js';
import supabase from '../../../../lib/supabase.js';

/**
 * GET /api/campaign/sessions
 *
 * Returns all campaign sessions (briefs + orchestrator sessions) for the session list.
 * Ordered by most recent first.
 */
export async function GET() {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: briefs, error } = await supabase
      .from('campaign_briefs')
      .select('id, brief, completion, status, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const briefIds = (briefs || []).map(b => b.id);

    let sessions = [];
    let firstMessages = {};

    if (briefIds.length > 0) {
      // Fetch orchestrator sessions
      const { data, error: sessErr } = await supabase
        .from('orchestrator_sessions')
        .select('id, brief_id, status, current_phase, phase_results, created_at')
        .in('brief_id', briefIds)
        .order('created_at', { ascending: false });

      if (sessErr) throw sessErr;
      sessions = data || [];

      // Fetch the first user message per session from orchestrator_messages
      const sessionIds = sessions.map(s => s.id);
      if (sessionIds.length > 0) {
        const { data: msgs, error: msgErr } = await supabase
          .from('orchestrator_messages')
          .select('session_id, content')
          .in('session_id', sessionIds)
          .eq('role', 'user')
          .order('message_index', { ascending: true });

        if (!msgErr && msgs) {
          const sessionToBrief = {};
          for (const s of sessions) {
            sessionToBrief[s.id] = s.brief_id;
          }
          for (const m of msgs) {
            const briefId = sessionToBrief[m.session_id];
            if (briefId && !firstMessages[briefId]) {
              firstMessages[briefId] = m.content;
            }
          }
        }
      }
    }

    // Group sessions by brief_id (take latest)
    const sessionByBrief = {};
    for (const s of sessions) {
      if (!sessionByBrief[s.brief_id]) {
        sessionByBrief[s.brief_id] = s;
      }
    }

    // Build response
    const result = (briefs || []).map(b => {
      const session = sessionByBrief[b.id];

      // Derive phase progress
      const phaseOrder = ['intake', 'research', 'strategy', 'creative_plan', 'creative', 'execution'];
      let currentPhaseIndex = 0;
      let displayStatus = 'intake';

      if (session) {
        if (session.status === 'brief_completed' || (session.status === 'draft' && b.status === 'completed')) {
          // Brief is ready, but orchestration has not started yet
          displayStatus = 'brief_completed';
          currentPhaseIndex = 1;
        } else if (session.status === 'draft' || session.status === 'intake') {
          // Still in intake phase
          displayStatus = 'intake';
          currentPhaseIndex = 0;
        } else if (session.status === 'completed') {
          displayStatus = 'completed';
          currentPhaseIndex = phaseOrder.length - 1;
        } else {
          displayStatus = session.status;
          const cp = session.current_phase;
          if (cp) {
            const idx = phaseOrder.indexOf(cp);
            if (idx >= 0) currentPhaseIndex = idx;
          }
        }
      } else if (b.status === 'completed') {
        currentPhaseIndex = 1;
        displayStatus = 'brief_completed';
      }

      return {
        brief_id: b.id,
        session_id: session?.id || null,
        first_message: firstMessages[b.id] || null,
        status: displayStatus,
        current_phase: session?.current_phase || 'intake',
        phase_index: currentPhaseIndex,
        completion_pct: b.completion?.completion_pct || 0,
        created_at: b.created_at,
        updated_at: b.updated_at || b.created_at,
      };
    });

    return Response.json({ data: result });
  } catch (error) {
    console.error('[campaign/sessions] Error:', error);
    return Response.json({ error: 'Failed to load sessions' }, { status: 500 });
  }
}
